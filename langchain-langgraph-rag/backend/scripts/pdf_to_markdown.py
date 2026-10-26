#!/usr/bin/env python3
"""Convert a PDF to per-page Markdown with a layout-aware parser.

Prints one JSON object on stdout: {"engine": "...", "pages": [{"page": 1, "markdown": "..."}]}.
Anything else (progress, warnings) goes to stderr, because stdout is the data channel.

  python scripts/pdf_to_markdown.py --engine pymupdf file.pdf
  python scripts/pdf_to_markdown.py --engine docling file.pdf

Engines are imported lazily, so only the one you use needs to be installed:
  docling   pip install docling           (layout and table models; MIT licence; recommended)
  pymupdf   pip install "pymupdf4llm<2"   (fast, rule-based; AGPL licence)
"""
import argparse
import contextlib
import html
import json
import re
import sys


def clean_table_row(line: str) -> str:
    """Table cells arrive wrapped in bold markers ("**HTE** **(O)**"). They only
    add tokens, so drop them and the doubled spaces they leave."""
    line = line.replace("**", "")
    line = re.sub(r"[ \t]{2,}", " ", line)
    return re.sub(r"-{4,}", "---", line)  # separator rows padded to the column width


def tidy(markdown: str) -> str:
    """Remove parser noise that would only pollute the index."""
    markdown = re.sub(r"<!--.*?-->", "", markdown, flags=re.S)  # picture-text markers
    markdown = re.sub(r"<br\s*/?>", " ", markdown)  # line breaks inside table cells
    markdown = "\n".join(clean_table_row(line) if line.lstrip().startswith("|") else line for line in markdown.split("\n"))
    markdown = re.sub(r"\n{3,}", "\n\n", markdown)
    return markdown.strip()


def pymupdf_pages(path: str):
    import pymupdf4llm  # type: ignore

    chunks = pymupdf4llm.to_markdown(path, page_chunks=True, show_progress=False)
    return [chunk["text"] for chunk in chunks]


def docling_pages(path: str):
    from docling.datamodel.base_models import InputFormat  # type: ignore
    from docling.datamodel.pipeline_options import PdfPipelineOptions  # type: ignore
    from docling.document_converter import DocumentConverter, PdfFormatOption  # type: ignore

    # OCR is off: pages without a text layer are routed to the OCR agent by the
    # Node pipeline, and Docling's own OCR is what makes it take minutes a page.
    options = PdfPipelineOptions()
    options.do_ocr = False
    converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)})
    document = converter.convert(path).document
    return [html.unescape(document.export_to_markdown(page_no=number)) for number in sorted(document.pages.keys())]


ENGINES = {"pymupdf": pymupdf_pages, "docling": docling_pages}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--engine", choices=sorted(ENGINES), required=True)
    parser.add_argument("pdf")
    args = parser.parse_args()

    try:
        # Parsers print progress to stdout; stdout carries only our JSON.
        with contextlib.redirect_stdout(sys.stderr):
            pages = ENGINES[args.engine](args.pdf)
    except ImportError as error:
        print(f"engine '{args.engine}' is not installed: {error}", file=sys.stderr)
        return 2
    json.dump(
        {"engine": args.engine, "pages": [{"page": index + 1, "markdown": tidy(text)} for index, text in enumerate(pages)]},
        sys.stdout,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
