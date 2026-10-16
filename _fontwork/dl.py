"""Download latin/latin-ext woff2 files referenced in Google Fonts css2 responses."""
import re, pathlib, urllib.request

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"}
here = pathlib.Path(__file__).parent
(here / "dl").mkdir(exist_ok=True)

def blocks(css_text):
    # split on /* subset */ comments
    parts = re.split(r"/\*\s*([a-z-]+)\s*\*/", css_text)
    # parts: [pre, subset, body, subset, body...]
    out = []
    for i in range(1, len(parts) - 1, 2):
        subset, body = parts[i], parts[i + 1]
        w = re.search(r"font-weight:\s*([\d\.]+(?:\s[\d\.]+)?)", body)
        url = re.search(r"url\((https://[^)]+\.woff2)\)", body)
        if url:
            out.append((subset, (w.group(1).replace(" ", "-") if w else "?"), url.group(1)))
    return out

total = 0
for css_name, fam in [("ss4.css", "SourceSerif4"), ("plex.css", "IBMPlexMono")]:
    text = (here / css_name).read_text()
    for subset, w, url in blocks(text):
        if subset not in ("latin", "latin-ext"):
            continue
        dest = here / "dl" / f"{fam}-{w}-{subset}.woff2"
        if not dest.exists():
            req = urllib.request.Request(url, headers=UA)
            dest.write_bytes(urllib.request.urlopen(req, timeout=30).read())
        print(dest.name, dest.stat().st_size)
        total += dest.stat().st_size
print("TOTAL", total)
