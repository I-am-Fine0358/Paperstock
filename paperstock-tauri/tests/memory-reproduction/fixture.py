#!/usr/bin/env python3
"""Create an isolated, deterministic image-heavy PDF fixture; stdlib only."""
import pathlib
import random
import sys
import zlib

output = pathlib.Path(sys.argv[1])
image_size = int(sys.argv[2]) if len(sys.argv) > 2 else 768
objects = []


def add(value):
    objects.append(value)
    return len(objects)


catalog = add(b"")
pages = add(b"")
font = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
children = []
for index in range(24):
    # Separate images prevent shared-resource deduplication from hiding caches.
    rng = random.Random(12000 + index)
    data = zlib.compress(rng.randbytes(image_size * image_size * 3), 1)
    image = add(f"<< /Type /XObject /Subtype /Image /Width {image_size} /Height {image_size} ".encode()
                + b"/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode "
                + f"/Length {len(data)} >>\nstream\n".encode() + data + b"\nendstream")
    operators = (f"q 540 0 0 660 36 66 cm /Im0 Do Q\n"
                 f"BT /F1 18 Tf 36 756 Td (Paperstock memory fixture - page {index + 1}) Tj ET\n").encode()
    content = add(f"<< /Length {len(operators)} >>\nstream\n".encode() + operators + b"endstream")
    child = add((f"<< /Type /Page /Parent {pages} 0 R /MediaBox [0 0 612 792] "
                 f"/Resources << /XObject << /Im0 {image} 0 R >> /Font << /F1 {font} 0 R >> >> "
                 f"/Contents {content} 0 R >>").encode())
    children.append(child)
objects[catalog - 1] = f"<< /Type /Catalog /Pages {pages} 0 R >>".encode()
objects[pages - 1] = (f"<< /Type /Pages /Count {len(children)} /Kids ["
                     + " ".join(f"{child} 0 R" for child in children) + "] >>").encode()
output.parent.mkdir(parents=True, exist_ok=True)
with output.open("wb") as file:
    file.write(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(file.tell())
        file.write(f"{index} 0 obj\n".encode() + obj + b"\nendobj\n")
    xref = file.tell()
    file.write(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:
        file.write(f"{offset:010d} 00000 n \n".encode())
    file.write((f"trailer\n<< /Size {len(offsets)} /Root {catalog} 0 R >>\n"
                f"startxref\n{xref}\n%%EOF\n").encode())
print(f"{output}: {output.stat().st_size} bytes, 24 pages")
