import sys
import os
import json
from docling.document_converter import DocumentConverter

def convert_to_markdown(file_path):
    converter = DocumentConverter()
    result = converter.convert(file_path)
    return result.document.export_to_markdown()

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 docling-wrapper.py <file_path>")
        sys.exit(1)
    
    file_path = sys.argv[1]
    if not os.path.exists(file_path):
        print(f"Error: File {file_path} not found")
        sys.exit(1)
        
    try:
        markdown = convert_to_markdown(file_path)
        print(markdown)
    except Exception as e:
        print(f"Error converting {file_path}: {e}", file=sys.stderr)
        sys.exit(1)
