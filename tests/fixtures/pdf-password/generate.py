"""Regenerate synthetic encrypted PDFs. Development only; CI reads committed bytes."""
from io import BytesIO
from pathlib import Path
from pypdf import PdfReader, PdfWriter


def source_pdf():
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>"]
    for index in range(2):
        drawing = (
            f"1 0 0 rg 0 0 12 840 re f\n0 0 1 rg 588 0 12 840 re f\n"
            f"0 1 0 rg 0 0 600 12 re f\n0 0 0 rg BT /F1 20 Tf 40 780 Td "
            f"(Synthetic encrypted statement - page {index + 1}) Tj ET\n"
        ).encode("ascii")
        objects.extend([
            (f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 840] "
             f"/Resources << /Font << /F1 7 0 R >> >> /Contents {4 + index * 2} 0 R >>").encode("ascii"),
            b"<< /Length " + str(len(drawing)).encode("ascii") + b" >>\nstream\n" + drawing + b"endstream",
        ])
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    data, offsets = b"%PDF-1.7\n", [0]
    for index, obj in enumerate(objects):
        offsets.append(len(data))
        data += f"{index + 1} 0 obj\n".encode("ascii") + obj + b"\nendobj\n"
    xref = len(data)
    data += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode("ascii")
    data += b"".join(f"{offset:010} 00000 n \n".encode("ascii") for offset in offsets[1:])
    data += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode("ascii")
    return data


for algorithm, password, filename in [
    ("AES-128", "fixture-pass-128", "aes128.pdf"),
    ("AES-256", " fixture-pass-256 ", "aes256.pdf"),
]:
    writer = PdfWriter(clone_from=PdfReader(BytesIO(source_pdf())))
    writer.encrypt(password, owner_password="fixture-owner-only", algorithm=algorithm)
    with Path(__file__).with_name(filename).open("wb") as output:
        writer.write(output)
