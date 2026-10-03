# Ověření nasazení rendereru videa

Při ověření veřejného URL `video-renderer.html` prohlížeč obdržel zdrojový HTML text místo vykreslené stránky. Obsah souboru je správný, ale metadata objektu ve veřejném Supabase Storage pravděpodobně stále neoznačují objekt jako vykonatelné HTML nebo jej vybavují vynuceným zobrazením zdrojového obsahu.

Další krok je zjistit skutečné HTTP hlavičky objektu a nahrát jej přes rozhraní, které nastaví `content-type: text/html; charset=utf-8` do metadat objektu.
