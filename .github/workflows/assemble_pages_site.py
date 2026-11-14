#!/usr/bin/env python3
"""Build the GitHub Pages artifact for dadsofgod.com.

The artifact is an allow-list, not a copy of the repository:

  * every *.html file at the repository root, including 404.html
  * image and icon files (and image-only folders) those pages reference
  * CNAME, .nojekyll, robots.txt, sitemap.xml
  * pool-ledger.json, when it is present
  * an image on this host that api/ links in customer email, such as
    email-logo.png (the JavaScript itself is never copied)

api/, test/, node_modules, .github, package.json, package-lock.json,
vercel.json, and Markdown docs are refused. The step exits non-zero if a
local src/href, or a same-host image URL in an HTML content attribute,
does not exist inside the artifact.
"""

from __future__ import annotations

import argparse
import re
import shutil
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse

REQUIRED = ("CNAME", ".nojekyll", "robots.txt", "sitemap.xml")
# GitHub Pages looks for this exact filename. The root HTML glob publishes
# it; failing here keeps it from quietly dropping out of the allow-list.
REQUIRED_HTML = ("404.html",)
OPTIONAL = ("pool-ledger.json",)
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".avif", ".bmp"}
SITE_HOSTS = {"www.dadsofgod.com", "dadsofgod.com"}
DENY_DIRS = {"api", "test", "node_modules", ".github", ".git"}
DENY_FILES = {"package.json", "package-lock.json", "vercel.json"}

ATTR_RE = re.compile(
    r"""(?:^|[\s])(?P<attr>src|href)\s*=\s*(?P<q>["'])(?P<val>.*?)(?P=q)""",
    re.IGNORECASE | re.DOTALL,
)
SRCSET_RE = re.compile(
    r"""(?:^|[\s])srcset\s*=\s*(?P<q>["'])(?P<val>.*?)(?P=q)""",
    re.IGNORECASE | re.DOTALL,
)
CONTENT_RE = re.compile(
    r"""(?:^|[\s])content\s*=\s*(?P<q>["'])(?P<val>.*?)(?P=q)""",
    re.IGNORECASE | re.DOTALL,
)
COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
API_URL_RE = re.compile(
    r"""https?://(?:www\.)?dadsofgod\.com(?:/[^\s"'<>\\)]*)?""",
    re.IGNORECASE,
)


def fail(message: str) -> None:
    print("ERROR: Pages site assembly failed.", file=sys.stderr)
    print(message, file=sys.stderr)
    raise SystemExit(1)


def is_denied(rel: str) -> bool:
    parts = [part for part in rel.split("/") if part not in ("", ".")]
    if not parts:
        return False
    if any(part in DENY_DIRS for part in parts):
        return True
    if parts[-1] in DENY_FILES or parts[-1].lower().endswith(".md"):
        return True
    return False


def inside(root: Path, path: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError:
        return False
    return True


def normalize_local(raw: str) -> str | None:
    """Return a repo-relative path, or None when the URL is not a site file."""
    text = " ".join(raw.split())
    if not text or text.startswith(("#", "mailto:", "tel:", "javascript:", "data:")):
        return None
    parsed = urlparse(text)
    if parsed.scheme in ("http", "https"):
        host = (parsed.hostname or "").lower()
        if host not in SITE_HOSTS:
            return None
        path = parsed.path
    elif parsed.scheme:
        return None
    else:
        path = parsed.path
    path = unquote(path).replace("\\", "/")
    if path in ("", "/"):
        return None
    if path.startswith("/"):
        path = path[1:]
    parts: list[str] = []
    for part in path.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            fail(f"Refusing a path that escapes the site root: {raw!r}")
        parts.append(part)
    if not parts:
        return None
    rel = "/".join(parts)
    if is_denied(rel):
        fail(f"Refusing to publish {rel}, referenced as {raw!r}")
    return rel


def html_text(path: Path) -> str:
    return COMMENT_RE.sub("", path.read_text(encoding="utf-8"))


def local_refs(text: str) -> list[tuple[str, str, str]]:
    """(kind, raw, rel) where kind is 'link' for src/href and 'image' otherwise."""
    found: list[tuple[str, str, str]] = []
    for match in ATTR_RE.finditer(text):
        rel = normalize_local(match.group("val"))
        if rel:
            found.append(("link", match.group("val").strip(), rel))
    for match in SRCSET_RE.finditer(text):
        for piece in match.group("val").split(","):
            url = piece.strip().split()[0] if piece.strip() else ""
            if not url:
                continue
            rel = normalize_local(url)
            if rel:
                found.append(("image", url, rel))
    for match in CONTENT_RE.finditer(text):
        rel = normalize_local(match.group("val"))
        if rel and Path(rel).suffix.lower() in IMAGE_EXTS:
            found.append(("image", match.group("val").strip(), rel))
    return found


COPIED: set[str] = set()


def copy_file(root: Path, site: Path, rel: str, why: str) -> None:
    src = root / rel
    if src.is_symlink() and not inside(root, src):
        fail(f"Refusing symlink {rel} because it points outside the repository")
    if not src.is_file():
        fail(f"Missing {rel} ({why})")
    if is_denied(rel):
        fail(f"Refusing to publish {rel} ({why})")
    dest = site / rel
    if not inside(site, dest):
        fail(f"Refusing to write {rel} outside the artifact")
    if rel in COPIED:
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest)
    COPIED.add(rel)
    print(f"copied {rel} ({why})")


def copy_image(root: Path, site: Path, rel: str, why: str) -> None:
    src = root / rel
    if src.is_symlink() and not inside(root, src):
        fail(f"Refusing symlink {rel} because it points outside the repository")
    if src.is_dir():
        files = [path for path in src.rglob("*") if path.is_file()]
        if not files:
            fail(f"{why}: {rel} is an empty folder")
        for path in files:
            child = path.relative_to(root).as_posix()
            if is_denied(child) or path.suffix.lower() not in IMAGE_EXTS:
                fail(
                    f"{why}: folder {rel} contains {child}, which is not an image or icon. "
                    "The Pages artifact only copies image folders the site references."
                )
        for path in files:
            copy_file(root, site, path.relative_to(root).as_posix(), why)
        return
    if not src.is_file():
        fail(f"Missing {rel} ({why})")
    if src.suffix.lower() not in IMAGE_EXTS:
        fail(f"{why}: {rel} is not an image or icon file")
    copy_file(root, site, rel, why)


def assemble(root: Path, site: Path) -> list[str]:
    COPIED.clear()
    if site == root or inside(site, root):
        fail(f"Artifact directory {site} must not contain the repository")
    if site.exists():
        shutil.rmtree(site)
    site.mkdir(parents=True)

    html_files = sorted(path for path in root.glob("*.html") if path.is_file())
    if not html_files:
        fail("No HTML files at the repository root.")
    html_names = {path.name for path in html_files}
    missing_html = [name for name in REQUIRED_HTML if name not in html_names]
    if missing_html:
        fail(
            "These pages are on the Pages allow-list and must be published:\n  "
            + "\n  ".join(missing_html)
        )
    for path in html_files:
        copy_file(root, site, path.name, "root HTML page")

    for name in REQUIRED:
        if not (root / name).is_file():
            fail(f"Required site file is missing: {name}")
        copy_file(root, site, name, "required site file")

    for name in OPTIONAL:
        if (root / name).is_file():
            copy_file(root, site, name, "optional public site file")

    for path in html_files:
        for kind, raw, rel in local_refs(html_text(path)):
            if kind == "image" or Path(rel).suffix.lower() in IMAGE_EXTS:
                copy_image(root, site, rel, f"{path.name} references {raw}")

    api = root / "api"
    if api.is_dir():
        for script in sorted(api.rglob("*.js")):
            if not script.is_file():
                continue
            origin = script.relative_to(root).as_posix()
            for match in API_URL_RE.finditer(script.read_text(encoding="utf-8", errors="replace")):
                rel = normalize_local(match.group(0))
                if rel is None:
                    continue
                suffix = Path(rel).suffix.lower()
                if suffix in IMAGE_EXTS:
                    copy_image(
                        root,
                        site,
                        rel,
                        f"{origin} loads https://www.dadsofgod.com/{rel} (email or public image; source is not published)",
                    )
                elif suffix == ".html" and not (site / rel).is_file():
                    fail(
                        f"{origin} links to https://www.dadsofgod.com/{rel}, "
                        "but that page is not in the Pages artifact"
                    )

    missing: list[str] = []
    for page in sorted(site.rglob("*.html")):
        for kind, raw, rel in local_refs(html_text(page)):
            if kind != "link" and Path(rel).suffix.lower() not in IMAGE_EXTS:
                continue
            if not (site / rel).exists():
                where = page.relative_to(site).as_posix()
                missing.append(f"{where} references {raw} ({rel} is not in the artifact)")
    if missing:
        fail(
            "A page references a file that was not copied into the Pages artifact:\n  "
            + "\n  ".join(missing)
        )

    files = sorted(
        path.relative_to(site).as_posix()
        for path in site.rglob("*")
        if path.is_file()
    )
    leaked = [
        rel
        for rel in files
        if is_denied(rel) or rel.startswith("api/") or rel.startswith("test/")
    ]
    if leaked:
        fail("Denied files were copied into the artifact:\n  " + "\n  ".join(leaked))
    if not files:
        fail("The Pages artifact is empty.")

    print(f"Pages artifact ({len(files)} files):")
    for rel in files:
        print(f"  {rel}")
    return files


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("."))
    parser.add_argument("--site", type=Path, default=Path("_site"))
    args = parser.parse_args()
    root = args.root.resolve()
    site = args.site if args.site.is_absolute() else (Path.cwd() / args.site).resolve()
    if not root.is_dir():
        fail(f"Repository root does not exist: {root}")
    assemble(root, site)


if __name__ == "__main__":
    main()
