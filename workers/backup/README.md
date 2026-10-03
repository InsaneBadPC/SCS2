# songcraft-backup — instalace a konvence

Tato jednotka kopíruje konvence `workers/video-renderer/songcraft-renderer.service.example`:
neprivilegovaný uživatel, `EnvironmentFile=`, `NoNewPrivileges`, `PrivateTmp`,
`ProtectSystem=strict`, `ProtectHome=true`, omezené `ReadWritePaths`.

Úloha zálohy navíc drží **service role key a heslo do Postgres**, proto dostává
i sadu direktiv, kterou renderer nepotřebuje (`CapabilityBoundingSet=`,
`SystemCallFilter=@system-service`, `RestrictAddressFamilies`, `UMask=0077`).
Všechny jsou fail-closed — úloha se zastaví, místo aby si sama rozšířila sandbox.

## Soubory

| Soubor | Účel |
|---|---|
| `songcraft-backup.service` | `Type=oneshot`, volá `scripts/backup-service.sh` |
| `songcraft-backup.timer` | `OnCalendar=*-*-* 03:17:00 UTC`, `Persistent=true` |
| `songcraft-backup-notify@.service` | `OnFailure=` cílová jednotka |

## Instalace na VM

```bash
sudo useradd --system --home-dir /var/lib/songcraft-studio --shell /usr/sbin/nologin songcraft-backup
sudo install -d -o songcraft-backup -g songcraft-backup -m 0700 /var/lib/songcraft-studio/backups

sudo install -d -o root -g root -m 0755 /etc/songcraft-studio
sudo install -o root -g songcraft-backup -m 0640 /dev/null /etc/songcraft-studio/backup.env
sudo -u songcraft-backup true   # sanity: účet existuje

sudo install -m 0644 songcraft-backup.service \
     /etc/systemd/system/songcraft-backup.service
sudo install -m 0644 songcraft-backup.timer \
     /etc/systemd/system/songcraft-backup.timer
sudo install -m 0644 songcraft-backup-notify@.service \
     /etc/systemd/system/songcraft-backup-notify@.service

sudo systemctl daemon-reload
sudo systemctl enable --now songcraft-backup.timer
systemctl list-timers songcraft-backup.timer    # ověřit, že příští běh je v plánu
```

## První běh ručně (před zapnutím timeru)

```bash
sudo systemd-run --unit=songcraft-backup-dryrun --property=Type=oneshot \
     --property=User=songcraft-backup \
     /usr/bin/bash /opt/songcraft-studio/scripts/backup-service.sh
journalctl -u songcraft-backup-dryrun -n 100
```

Teprve když je v logu `backup-run: done: …` **a** `pg_restore --list` prošel,
zapnout timer.

## Ověření, že sandbox dovoluje vše potřebné

```bash
systemd-analyze verify /etc/systemd/system/songcraft-backup.service
sudo systemctl show songcraft-backup.service -p ProtectSystem -p ReadWritePaths
systemd-analyze security songcraft-backup.service   # skóre < 3 je cílem
```

`aws` a `oci` CLI musejí být čitelné z `ReadOnlyPaths` — proto `ProtectSystem=strict`
a `ReadWritePaths` jen na `/var/lib/songcraft-studio`. Pokud CLI potřebuje zápis do
`~/.oci`, přesuňte profil do `/etc/songcraft-studio` a exportujte `OCI_CONFIG_FILE`
v `backup.env`.