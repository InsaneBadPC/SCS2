# SongCraft Studio — návrh mobilního rozhraní

## Záměr produktu

SongCraft Studio je soukromé pracovní prostředí autora a hudebníka. Spojuje rozepsané texty, promyšlené podklady pro generátory hudby, přebaly a více exportovaných zvukových verzí do jedné struktury **album → skladba → verze**. Aplikace je určena především pro rychlou práci v mobilním portrétním zobrazení, stejný obsah je však dostupný i ve webovém rozhraní a je synchronizován v cloudu.

## Principy rozhraní

Rozhraní pracuje v portrétním poměru 9:16 a respektuje běžné zvyklosti iOS a Androidu: horní navigace, čitelné řádkové seznamy, hlavní akce ve spodním dosahu palce a systémové panely pro formuláře. Tmavé „studio“ rozhraní s teplým akcentem odděluje kreativní psaní od technické správy nahrávek. Každá změna je lokálně viditelná okamžitě a po uložení se bezpečně promítne do cloudového katalogu.

| Prvek | Návrh | Důvod |
|---|---|---|
| Primární barva | `#C6784E` — měděná | Rozpoznatelný, kreativní akcent pro tvorbu a hlavní akce. |
| Pozadí | `#141317` | Klidný tmavý podklad vhodný pro dlouhé psaní. |
| Povrch karet | `#211F25` | Jasně odděluje sekce bez výrazných rámečků. |
| Text | `#F4EFE8` | Teplý kontrast, který neunavuje při čtení textů. |
| Stav dokončeno | `#6BAA82` | Jednoznačně označuje skladbu připravenou pro katalog. |
| Stav rozpracováno | `#9B91A7` | Udržuje pozornost na aktivní tvorbě bez alarmujícího tónu. |

## Seznam obrazovek

| Obrazovka | Primární obsah | Klíčové akce |
|---|---|---|
| Přehled | Rozpracované texty, poslední změny, rychlé souhrny alb a skladeb. | Vytvořit text, pokračovat ve psaní, otevřít album. |
| Texty | Vyhledávatelný seznam konceptů, filtr alba a stavů. | Založit, otevřít, duplikovat, archivovat koncept. |
| Editor textu | Název, album, stylový prompt, strukturovaný text písně, poznámky, přebal a stav. | Uložit, přidat obrázek, zkopírovat prompt/text, označit jako hotové. |
| Alba | Mřížka / seznam alb s počtem konceptů a hotových skladeb. | Vytvořit album, upravit název/rok/obal, zobrazit skladby. |
| Knihovna skladeb | Hotové skladby seskupené pod alby se stavem verzí. | Otevřít skladbu, vyhledat, filtrovat podle alba. |
| Detail skladby | Samostatné bloky pro prompt, text a přiřazené MP3 verze. | Kopírovat text, přehrát verzi, otevřít správu verzí. |
| Správa verze | Název souboru, pořadí verze, zdrojový MP3 soubor a pole ID3. | Přidat nebo odebrat soubor, upravit pracovní metadata, označit hlavní verzi. |
| Nastavení | Stav synchronizace, pozdější export a ochrana soukromí. | Obnovit data, přepnout zobrazení, zobrazit historii. |

## Hlavní uživatelské toky

### 1. Text od nápadu po hotovou skladbu

Uživatel na Přehledu zvolí **Nový text**, zadá pracovní název a zařadí jej do existujícího nebo nového alba. V editoru doplní prompt pro hudební generátor, vlastní text a případné poznámky k aranži. Z galerie nebo souborů přidá přebal. Po kontrole zvolí **Označit jako hotové**; koncept se nemaže, ale změní stav a zobrazí se v Knihovně skladeb se všemi zdrojovými informacemi.

### 2. Příprava hudebního generátoru

V detailu hotové skladby uživatel otevře blok **Prompt stylu** nebo **Text písně**. Jediným klepnutím zkopíruje zvolený obsah do systémové schránky a vloží jej do libovolného hudebního generátoru. Obsah se dále nemění ani nezkracuje; je načítán z potvrzené verze textového dokumentu.

### 3. Správa několika zvukových verzí

Uživatel v detailu skladby otevře **Spravovat verze**, vybere MP3 ze zařízení a přiřadí jí označení, například „V1 – demo“ nebo „Master“. Každá verze nese vlastní pracovní název souboru a sadu metadat (název, interpret, album, číslo stopy, žánr, rok a komentář). Jedna verze může být označena jako hlavní. Odebrání z katalogu nezpůsobí odstranění celé skladby ani jejích textů.

### 4. Spolehlivá synchronizace

Textová data, vazby alb a položky katalogu jsou uloženy v databázi; binární soubory přebalů a MP3 jsou v odděleném objektovém úložišti. Každá položka uchovává čas změny. Rozhraní bude zobrazovat stav uložení a při opětovném načtení obnoví poslední cloudový stav. Soukromé záznamy budou dostupné jen přihlášenému vlastníku.

## Datový slovník

| Entita | Účel | Zásadní pole |
|---|---|---|
| Album | Seskupuje koncepty i hotové skladby. | název, rok, popis, obal, pořadí |
| Textový dokument | Kreativní koncept nebo schválený základ skladby. | název, text, prompt stylu, poznámky, stav, album, obrázek |
| Skladba | Katalogová položka vzniklá potvrzením textu. | název, album, odkaz na zdrojový dokument, datum dokončení |
| Zvuková verze | Jedna MP3 varianta skladby. | soubor, popisek, hlavní verze, délka, velikost, metadata |
| Metadata verze | Pracovní editovatelná sada ID3 údajů. | title, artist, album, track, year, genre, comment |

## Rozšíření, která systém připravuje

Návrh počítá s historií verzí textu, měkkým archivem, inteligentním vyhledáváním přes název/prompt/text, exportním kontrolním seznamem pro YouTube (přebal, finální název, master, metadata) a označením stavu nahrávky. Zápis ID3 tagů přímo do binárního MP3 souboru bude realizován jako samostatný exportní krok: nikdy nepřepíše originál, ale vytvoří novou, jasně pojmenovanou kopii připravenou k publikování.
