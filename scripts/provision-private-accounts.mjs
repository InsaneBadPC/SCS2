const SUPABASE_URL = "https://hfykngbhcxmnpxvjagoj.supabase.co";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const accounts = [
  {
    displayName: "Temney",
    email: "temney@songcraft.test",
    password: process.env.SONGCRAFT_TEMNEY_PASSWORD,
  },
  {
    displayName: "DJ Palačinka",
    email: "dj.palacinka@songcraft.test",
    password: process.env.SONGCRAFT_DJ_PALACINKA_PASSWORD,
  },
  {
    displayName: "Verča",
    email: "verca@songcraft.test",
    password: process.env.SONGCRAFT_VERCA_PASSWORD,
  },
];

if (!serviceRoleKey) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY is required.");
}

for (const account of accounts) {
  if (!account.password || account.password.length < 8) {
    throw new Error(`A password with at least 8 characters is required for ${account.displayName}.`);
  }
}

const headers = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  "Content-Type": "application/json",
};

async function listUsers() {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=1000&page=1`, { headers });
  if (!response.ok) throw new Error(`Unable to list private accounts (${response.status}).`);
  const body = await response.json();
  return body.users ?? [];
}

async function ensureAccount(account, users) {
  const existing = users.find(
    (user) =>
      user.email?.toLocaleLowerCase() === account.email ||
      user.user_metadata?.display_name === account.displayName,
  );
  const body = {
    password: account.password,
    email_confirm: true,
    user_metadata: { display_name: account.displayName, private_account: true },
  };

  const response = existing
    ? await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${existing.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
      })
    : await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...body, email: account.email }),
      });

  if (!response.ok) throw new Error(`Unable to configure account ${account.displayName} (${response.status}).`);
  console.log(`Private account configured: ${account.displayName}`);
}

const users = await listUsers();
for (const account of accounts) {
  await ensureAccount(account, users);
}

console.log("All three private SongCraft accounts are ready.");
