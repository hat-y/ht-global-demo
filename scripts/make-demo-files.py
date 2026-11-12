#!/usr/bin/env python3
"""Generate synthetic sample files for the HT Global quote assistant demo.

Writes into demo/sample-files/:
  - FC-100_fabrication-drawing.pdf : one-page fabrication drawing (board outline + notes + stack-up)
  - FC-100_gerbers.zip             : minimal RS-274X Gerber set + Excellon drill file (100 x 80 mm board)

Everything is fictional ("Skyline Robotics", part FC-100). No dependencies: the PDF is written by hand.
"""
import io
import os
import zipfile

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'demo', 'sample-files')


def pdf_escape(text):
    return text.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)')


def build_pdf():
    ops = []

    def text(x, y, size, s, bold=False):
        ops.append(f'BT /{"F2" if bold else "F1"} {size} Tf {x:.1f} {y:.1f} Td ({pdf_escape(s)}) Tj ET')

    def line(x1, y1, x2, y2, w=0.8):
        ops.append(f'{w} w {x1:.1f} {y1:.1f} m {x2:.1f} {y2:.1f} l S')

    def rect(x, y, w, h, lw=1.2):
        ops.append(f'{lw} w {x:.1f} {y:.1f} {w:.1f} {h:.1f} re S')

    W, H = 842, 595  # A4 landscape
    rect(20, 20, W - 40, H - 40, 1.5)
    # title block
    rect(560, 30, 262, 110, 1)
    text(570, 120, 13, 'SKYLINE ROBOTICS', True)
    text(570, 102, 10, 'FC-100  Flight controller board')
    text(570, 86, 9, 'Fabrication drawing  -  Rev A  -  sheet 1/1')
    text(570, 70, 9, 'Units: mm   Tolerance: +/-0.10 unless noted')
    text(570, 54, 9, 'Demo file for HT Global Circuits RFQ')
    text(570, 38, 8, 'Fictional data - for demonstration only')

    # board outline, 100 x 80 mm, drawn at 1 mm = 2.6 pt
    bx, by = 70, 250
    bw, bh = 100 * 2.6, 80 * 2.6
    rect(bx, by, bw, bh, 2)
    for hx, hy in ((4, 4), (96, 4), (4, 76), (96, 76)):  # mounting holes 3.2 mm, 4 mm from edges
        cx, cy, r = bx + hx * 2.6, by + hy * 2.6, 1.6 * 2.6
        k = 0.5523 * r
        ops.append(
            f'0.8 w {cx + r:.1f} {cy:.1f} m {cx + r:.1f} {cy + k:.1f} {cx + k:.1f} {cy + r:.1f} {cx:.1f} {cy + r:.1f} c '
            f'{cx - k:.1f} {cy + r:.1f} {cx - r:.1f} {cy + k:.1f} {cx - r:.1f} {cy:.1f} c '
            f'{cx - r:.1f} {cy - k:.1f} {cx - k:.1f} {cy - r:.1f} {cx:.1f} {cy - r:.1f} c '
            f'{cx + k:.1f} {cy - r:.1f} {cx + r:.1f} {cy - k:.1f} {cx + r:.1f} {cy:.1f} c S'
        )
    # dimensions
    line(bx, by - 18, bx + bw, by - 18)
    line(bx, by - 12, bx, by - 24)
    line(bx + bw, by - 12, bx + bw, by - 24)
    text(bx + bw / 2 - 18, by - 34, 10, '100.00', True)
    line(bx + bw + 18, by, bx + bw + 18, by + bh)
    line(bx + bw + 12, by, bx + bw + 24, by)
    line(bx + bw + 12, by + bh, bx + bw + 24, by + bh)
    text(bx + bw + 28, by + bh / 2, 10, '80.00', True)
    text(bx, by + bh + 12, 9, '4x mounting holes 3.20 mm, 4.00 mm from edges, non-plated')
    text(bx, 160, 10, 'Panel: 2 x 2 array, 5.0 mm rails, V-score between boards, 3 fiducials', True)

    # fabrication notes
    nx, ny = 410, 530
    text(nx, ny, 12, 'FABRICATION NOTES', True)
    notes = [
        '1. Material: FR-4, Tg 170, halogen-free.',
        '2. Layers: 4. Finished thickness: 1.60 mm +/-10%.',
        '3. Copper: 1 oz outer, 1 oz inner, finished.',
        '4. Surface finish: ENIG (Ni 3-6 um, Au 0.05-0.1 um).',
        '5. Solder mask: green LPI, both sides. Silkscreen: white.',
        '6. Min trace / space: 0.10 / 0.10 mm. Min drill: 0.25 mm.',
        '7. Impedance: 50 ohm single-ended on L1 and L4, +/-10%.',
        '8. Quality: IPC-6012 Class 2, 100% electrical test.',
        '9. Quantity: 500 boards (125 panels of 2 x 2).',
        '10. Export classification: Commercial (not ITAR/EAR).',
    ]
    for i, n in enumerate(notes):
        text(nx, ny - 20 - i * 15, 9.5, n)

    # stack-up table
    sx, sy = 410, 330
    text(sx, sy, 12, 'STACK-UP (1.60 mm)', True)
    rows = [('L1  Top', 'Signal  1 oz'), ('Prepreg', '0.20 mm'), ('L2', 'GND plane  1 oz'),
            ('Core', '1.00 mm'), ('L3', 'PWR plane  1 oz'), ('Prepreg', '0.20 mm'), ('L4  Bottom', 'Signal  1 oz')]
    for i, (a, b) in enumerate(rows):
        y = sy - 22 - i * 16
        rect(sx, y - 4, 220, 16, 0.6)
        text(sx + 6, y, 9, a)
        text(sx + 100, y, 9, b)

    stream = '\n'.join(ops).encode('latin-1')
    objs = [
        b'<< /Type /Catalog /Pages 2 0 R >>',
        b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {W} {H}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>'.encode(),
        b'<< /Length ' + str(len(stream)).encode() + b' >>\nstream\n' + stream + b'\nendstream',
        b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
        b'<< /Title (FC-100 fabrication drawing - demo) /Author (Skyline Robotics - fictional) >>',
    ]
    out = io.BytesIO()
    out.write(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(out.tell())
        out.write(f'{i} 0 obj\n'.encode() + body + b'\nendobj\n')
    xref = out.tell()
    out.write(f'xref\n0 {len(objs) + 1}\n0000000000 65535 f \n'.encode())
    for off in offsets:
        out.write(f'{off:010d} 00000 n \n'.encode())
    out.write(f'trailer\n<< /Size {len(objs) + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())
    return out.getvalue()


def gerber(layer_name, body):
    head = ['G04 FC-100 demo Gerber - fictional data*', f'G04 Layer: {layer_name}*',
            '%FSLAX46Y46*%', '%MOMM*%', '%LPD*%', '%ADD10C,0.150000*%', '%ADD11C,0.250000*%', '%ADD12R,1.600000X1.600000*%']
    return '\n'.join(head + body + ['M02*']) + '\n'


def outline():
    pts = [(0, 0), (100, 0), (100, 80), (0, 80), (0, 0)]
    body = ['D10*', f'X{pts[0][0] * 10**6}Y{pts[0][1] * 10**6}D02*']
    body += [f'X{x * 10**6}Y{y * 10**6}D01*' for x, y in pts[1:]]
    return body


def copper(seed):
    body = ['D11*']
    for i in range(6):
        y = (10 + i * 10 + seed) * 10**6
        body += [f'X{10 * 10**6}Y{y}D02*', f'X{90 * 10**6}Y{y}D01*']
    body += ['D12*'] + [f'X{x * 10**6}Y{70 * 10**6}D03*' for x in (20, 35, 50, 65, 80)]
    return body


def drill():
    lines = ['M48', ';FC-100 demo drill file - fictional data', 'METRIC,TZ', 'T1C0.300', 'T2C3.200', '%', 'T1']
    lines += [f'X{x:.3f}Y{y:.3f}' for x in (20, 35, 50, 65, 80) for y in (30, 50)]
    lines += ['T2'] + [f'X{x:.3f}Y{y:.3f}' for x, y in ((4, 4), (96, 4), (4, 76), (96, 76))]
    lines += ['M30']
    return '\n'.join(lines) + '\n'


def build_zip():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('FC-100.GKO', gerber('Board outline', outline()))
        z.writestr('FC-100.GTL', gerber('Top copper', copper(0)))
        z.writestr('FC-100.G2L', gerber('Inner 1 - GND', ['G36*', 'X0Y0D02*', 'X100000000Y0D01*', 'X100000000Y80000000D01*', 'X0Y80000000D01*', 'X0Y0D01*', 'G37*']))
        z.writestr('FC-100.G3L', gerber('Inner 2 - PWR', ['G36*', 'X0Y0D02*', 'X100000000Y0D01*', 'X100000000Y80000000D01*', 'X0Y80000000D01*', 'X0Y0D01*', 'G37*']))
        z.writestr('FC-100.GBL', gerber('Bottom copper', copper(3)))
        z.writestr('FC-100.GTS', gerber('Top solder mask', ['D12*'] + [f'X{x * 10**6}Y{70 * 10**6}D03*' for x in (20, 35, 50, 65, 80)]))
        z.writestr('FC-100.GBS', gerber('Bottom solder mask', ['D12*'] + [f'X{x * 10**6}Y{70 * 10**6}D03*' for x in (20, 35, 50, 65, 80)]))
        z.writestr('FC-100.GTO', gerber('Top silkscreen', ['D10*', 'X5000000Y5000000D02*', 'X30000000Y5000000D01*']))
        z.writestr('FC-100.DRL', drill())
        z.writestr('README.txt', 'FC-100 flight controller - demo Gerber set (fictional).\n'
                                 '4 layers, 100 x 80 mm, 1.60 mm, ENIG, 1 oz, 50 ohm single-ended on L1/L4.\n'
                                 'Files: GKO outline, GTL/G2L/G3L/GBL copper, GTS/GBS mask, GTO silk, DRL Excellon drill.\n')
    return buf.getvalue()


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    pdf_path = os.path.join(OUT, 'FC-100_fabrication-drawing.pdf')
    zip_path = os.path.join(OUT, 'FC-100_gerbers.zip')
    with open(pdf_path, 'wb') as f:
        f.write(build_pdf())
    with open(zip_path, 'wb') as f:
        f.write(build_zip())
    for p in (pdf_path, zip_path):
        print(os.path.relpath(p), os.path.getsize(p), 'bytes')
