# SongCraft Studio — systémový návrh a provozní průvodce

## Účel systému

**SongCraft Studio** je soukromé tvůrčí prostředí pro autora, který potřebuje udržet pohromadě vznikající texty, prompty pro hudební generátory, obaly skladeb a různé audio verze. Aplikace funguje jako nativní Android klient i jako webové UI nad stejnými daty. Namísto volných složek v úložišti používá přesný model **album → textový dokument → hotová skladba → MP3 verze**. Tento model zabraňuje tomu, aby se přebal, text a audio soubor po několika iteracích rozešly.

> **Zásada bezpečnosti obsahu:** původní nahraná MP3 není při práci s ID3 tagy přepisována. Export tagované verze vytváří novou kopii, kterou lze použít pro publikování.

## Uživatelův pracovní cyklus

| Fáze | Uživatelova činnost | Co systém ukládá |
|---|---|---|
| Nápad | Založí koncept a zvolí album nebo ponechá text nezařazený. | Název, stav `rozpracováno`, čas změny. |
| Tvorba | Píše text, prompt pro generátor a produkční poznámky. | Úplný obsah dokumentu a vztah k albu. |
| Vizuál | Vybere přebal z telefonu nebo webového počítače. | Soubor obrázku v cloudovém úložišti, bezpečný odkaz v dokumentu. |
| Dokončení | Označí text jako hotový. | Nezničí koncept; vznikne katalogová skladba se stabilním odkazem na zdrojový dokument. |
| Hudební verze | Připojí libovolný počet MP3 souborů. | Každá verze má vlastní označení, název souboru, velikost, hlavní příznak a metadata. |
| Publikování | Upraví metadata a vytvoří exportní kopii. | Samostatná MP3 kopie s ID3 tagy; originál zůstává zachovaný. |

## Klíčové obrazovky

Domovský **Přehled** ukazuje práci, na které je vhodné pokračovat, počet konceptů, hotových skladeb a alb. **Texty** jsou vyhledávatelná dílna s filtrem podle alba; každá položka může obsahovat prompt, text, poznámky a cover. **Alba** dávají textům a skladbám souvislost a nabízejí místo pro jejich vizuální identitu.

Po označení konceptu jako hotového se objeví v **Knihovně skladeb**. Detail skladby rozděluje obsah do tří jasných bloků: prompt pro hudební generátor, text písně a přiřazené MP3 verze. Prompt a text lze vložit do systémové schránky jedním klepnutím. Správa verze nabízí označení verze, volbu hlavní verze, pracovní ID3 metadata, export nové tagované kopie a odebrání položky z katalogu.

## Datový model

| Entita | Vztahy | Odpovědnost |
|---|---|---|
| `albums` | Jedno album může obsahovat více dokumentů a skladeb. | Název, rok, popis, pořadí a obal. |
| `lyricDocuments` | Patří uživateli, volitelně albu; po dokončení se propojí se skladbou. | Koncept, prompt, text, poznámky, stav, samostatný cover. |
| `songs` | Je přesně jednou navázaná na zdrojový dokument, volitelně na album. | Katalog hotových skladeb bez duplikování textového obsahu. |
| `audioVersions` | Patří skladbě. | Originální MP3, označení verze, hlavní příznak, ID3 metadata a odkaz na tagovanou kopii. |

Každá tabulka obsahuje `userId`. Každý dotaz a zápis API je prováděn v autentizovaném kontextu a filtruje data na přihlášeného vlastníka. Uživatel proto nevidí cizí alba, texty ani soubory, ani pokud zná jejich číselné ID.

## Cloudová synchronizace a soubory

Databáze obsahuje vztahy, textová pole, stavy a metadata. Binární soubory se ukládají odděleně do objektového úložiště. Databáze si pamatuje **klíč objektu** a jeho aplikační URL, takže klient nenese dlouhodobé přístupové údaje ke cloudovému úložišti. Server soubory validuje podle určení: cover musí být obrázek a zvuková verze MP3. V první verzi je z důvodu spolehlivého mobilního nahrávání omezen jeden MP3 soubor na 25 MB.

Při načtení aplikace se stáhne jeden konzistentní snímek alba, dokumentů, skladeb a verzí. Po každém zápisu se klientská cache obnoví. Tento postup je jednoduchý, průhledný a vhodný pro osobní hudební katalog; pozdější verze může při vyšším objemu přejít na stránkování a lokální frontu změn pro offline režim.

## ID3 workflow

Uživatel nejprve spravuje **pracovní metadata** uvnitř katalogu: název, interpret, album, číslo stopy, rok, žánr a komentář. Tím může metadata připravit ještě před finálním exportem. Při volbě „Exportovat MP3 s ID3 tagy“ server načte originál, vloží aktuální hodnoty do nové kopie a uloží ji do odděleného exportního umístění. Katalog si uloží odkaz na výsledek. Tento přístup omezuje riziko ztráty původního souboru a podporuje opakované vytváření různých publikovatelných verzí.

## Co je v této verzi záměrně vyřešeno jinak

Přímé přepsání souboru v telefonu by bylo rizikové a nespolehlivé, zejména pokud soubor pochází z externího poskytovatele úložiště. Aplikace proto nevyměňuje originál za modifikovaný soubor. Místo toho vytváří jasně označený export, který může uživatel otevřít, stáhnout či nahrát na publikační platformu. Smazání MP3 položky z katalogu není destruktivní mazání nezvratného objektu; odpojí ji od katalogu a zachová auditovatelný bezpečný přístup.

## Doporučený další rozvoj

| Priorita | Rozšíření | Přínos |
|---|---|---|
| Vysoká | Přímé přehrávání MP3 s časovou osou a volbou hlavní verze. | Rychlé porovnání verzí bez opuštění aplikace. |
| Vysoká | Offline fronta změn a indikátor konfliktu. | Spolehlivá práce během cestování bez připojení. |
| Střední | Historie verzí textu a možnost obnovit odstavec. | Bezpečnější experimentování s refrény a slokami. |
| Střední | Kontrolní seznam pro YouTube: cover, název, master, metadata a popis. | Sníží počet chyb před publikováním. |
| Střední | Vlastní značky a plnotextové hledání ve skladbách. | Snadné nalezení rozpracovaného nápadu podle motivu nebo nálady. |
| Nízká | Export katalogu do CSV/ZIP. | Přenositelnost a archivace mimo aplikaci. |

## Provozní poznámky

Aplikace je připravena jako Expo projekt v portrétním režimu. Z téhož kódu vzniká Android klient i webové UI. Produkční Android sestavení se vytváří přes tlačítko **Publish** v projektovém rozhraní po uložení verze projektu; lokální sestavování APK se nepoužívá. Přihlášení je nutné pro cloudovou synchronizaci, protože každý obsah je soukromý a vázaný na konkrétní účet.
