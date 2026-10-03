# Ověření projektu

## Webový náhled

Dne 20. srpna 2026 byl v prohlížeči ověřen náhled na kořenové URL webové aplikace. Zobrazilo se jméno **SongCraft Studio**, uzamčená přihlašovací obrazovka a spodní navigace pro Přehled, Texty, Alba, Knihovnu a Nastavení. Uzamčený stav je očekávaný: cloudová data jsou dostupná až po autentizaci vlastníka.

Před ověřením byla upravena konfigurace webového běhu. Statický exportní režim byl odstraněn z vývojové konfigurace a souběžný proces již neukončuje server při korektním dokončení jedné pomocné úlohy Metra.

## Automatická kontrola

Byly úspěšně spuštěny příkazy `pnpm check`, `pnpm test` a `pnpm lint`. Vitest ověřil datový model SongCraft Studio ve dvou testech; původní test odhlášení zůstává záměrně přeskočený, protože vyžaduje samostatný autentizační kontext šablony.

## Integrovaný MP3 přehrávač

Přehrávač používá multiplatformní modul Expo Audio. V detailu skladby dovoluje zvolit kteroukoli přiřazenou verzi, spustit či pozastavit její poslech a posunout se o deset sekund zpět nebo vpřed. Zobrazuje aktivní verzi, stav načítání, průběh a délku. Přepnutí verze nejprve pozastaví předchozí přehrávání, takže se dvě MP3 nikdy nepřekrývají. Po rozšíření byly znovu úspěšně spuštěny `pnpm check`, `pnpm test` a `pnpm lint`.

## Hodnocení a finální verze

Každá audio verze nyní ukládá hodnocení od nuly do pěti hvězd. Označení hlavní verze je v rámci skladby vždy jedinečné. Označení finální verze současně nastaví zvolenou nahrávku jako hlavní a zruší hlavní i finální příznak ostatních verzí téže skladby, takže katalog, přehrávač a export vždy pracují s jednoznačnou preferovanou nahrávkou. Migrace databáze byla aplikována bez destruktivní změny stávajících dat; dřívější verze začínají s hodnocením nula a bez finálního příznaku.

## Řazení a filtrování katalogu

Detail skladby nyní nabízí přepínač mezi řazením MP3 verzí podle nejlepšího hodnocení a podle nejnovější verze. Knihovna skladeb obsahuje samostatný filtr „Pouze finální“, který zobrazí jen skladby s alespoň jednou verzí označenou jako finální a u výsledků ukazuje název této verze. Po rozšíření byly znovu úspěšně spuštěny `pnpm check`, `pnpm test` a `pnpm lint`.

## Propojený katalog textů a skladeb

Aplikace nyní pracuje se dvěma samostatnými katalogy. Katalog **Texty** je kreativní dílna, ve které každý dokument obsahuje prompt pro styl a samotný text písně; po označení jako hotový vytvoří nebo aktualizuje propojenou skladbu. Katalog **Skladby** současně dovoluje přímo založit položku skladby, zapsat do ní stejný prompt a text, přidat vlastní obrázek, přiřadit album a následně nahrát MP3 verze. Album má vlastní obal a funguje jako společné zařazení skladeb i textů. Při vytvoření nebo aktualizaci hotového textu se jeho obsah zkopíruje do propojené skladby, takže detail skladby zůstává soběstačný i pro export a MP3 metadata.

## Spravovaná MP3 kopie

Výběr MP3 v detailu skladby již nevede k okamžitému uložení neurčitě pojmenovaného souboru. Uživatel nejprve zadá název verze a volitelnou poznámku. Server následně vytvoří novou kopii v cloudovém úložišti se jménem odvozeným od interpreta Temney, názvu skladby, alba a názvu verze. Do ID3 tagů této kopie vloží interpreta Temney, název skladby, přiřazené album, poznámku a při dostupném obrázku také přebal skladby. Původní nahraná MP3 není přepisována.

## Stabilní provoz bez externích účtů

Nedokončené propojení s Google Drivem bylo zrušeno. SongCraft Studio dále používá stávající zabezpečený společný katalog aplikace, takže data zůstávají synchronizovaná mezi mobilním a webovým rozhraním bez přidávání účtu, API klíče nebo dalšího nastavení uživatele. Hromadný import nyní vytváří postupně číslované verze `V1`, `V2` a další. Obrazovka YouTube exportu zpřístupňuje finální verze k vyzvednutí spolu s přebalem a názvem pro publikaci. Závěrečné spuštění `pnpm check`, `pnpm test` a `pnpm lint` proběhlo úspěšně.

## Stažení souborů a kompletní záloha

V editoru verze MP3 a v YouTube exportu je nyní dostupná akce **Uložit MP3 do telefonu / sdílet**. V nativní aplikaci stáhne hotovou kopii do dočasného úložiště a otevře systémovou nabídku, kde ji lze uložit do Souborů či odeslat do jiné aplikace; webová verze spustí běžné stažení prohlížeče. Nastavení obsahuje **Exportovat celou knihovnu**, který vytvoří ZIP se souhrnným JSON manifestem, texty, prompty, poznámkami, alby, obrázky, všemi MP3 verzemi a jejich metadaty. Pro bezpečný běh exportu je velikost ZIP omezena na 300 MB.

## Průběh a export alb

Nastavení nyní při exportu jasně zobrazuje, zda aplikace shromažďuje soubory nebo už otevírá systémové uložení archivu. Pod kompletní zálohou je seznam vytvořených alb; zvolením libovolného alba vznikne samostatný ZIP s jeho texty, obrázky, skladbami, MP3 verzemi a metadaty. Závěrečné kontroly `pnpm check`, `pnpm test` a `pnpm lint` proběhly bez chyb.

## Hledač českých rýmů

Editor textu i přímý editor skladby nyní obsahují tlačítko **Hledač rýmů**. Po zadání slova panel nabídne rýmy z lokálního českého slovníku, rozlišuje přesnější a volnější shodu koncovek a vybraný návrh vloží na konec rozepsaného textu. Hledání funguje bez síťového připojení, cizího účtu i externí služby. Testy ověřují normalizaci české diakritiky a nalezení běžného rýmu; společně s typovou a lint kontrolou prošly úspěšně.

## Soukromý slovník autora

Panel hledače rýmů nyní umožňuje přidat hledané slovo do části **Můj slovník**. Vlastní slova se ukládají ke konkrétnímu přihlášenému uživateli a automaticky se přidávají do budoucích návrhů rýmů na telefonu i ve webovém rozhraní. Klepnutím na křížek u slova je možné položku ze slovníku odebrat. Testy ověřují, že vlastní slovo skutečně vstoupí do výsledků hledání; kontrola typů, testy i lint proběhly bez chyb.

## Import textů

Katalog **Texty** nyní nabízí akci **Importovat**. Uživatel může vybrat soubor TXT, Markdown, HTML nebo CSV; aplikace převede jeho obsah na čitelný text, založí nový koncept a otevře ho v editoru. Druhá cesta přijímá odkaz na Google Dokument a importuje jeho text do nového konceptu. Protože aplikace nevyžaduje externí přihlášení ke Googlu, musí být tento dokument nastavený na „kdokoli s odkazem může zobrazit“. Testy ověřují převod HTML na text a rozpoznání platného odkazu Google Dokumentu; `pnpm check`, testy i lint prošly.

## Rozšířený import

Importní panel nyní podporuje také DOCX a umožňuje vybrat více textových souborů v jedné akci. Každý soubor se stane samostatným novým konceptem v katalogu. Při zpracování aplikace rozpozná samostatně stojící označení jako `Verse 1`, `Sloka`, `Chorus`, `Refrén`, `Bridge`, `Intro` nebo `Outro` a sjednotí je do přehledného zápisu v hranatých závorkách, například `[Sloka 1]` a `[Refrén]`. Kontrola typů, testy i lint proběhly bez chyb.
