"""Adds punch 814 (AFH acute angle punch, 30 deg, R0.6) and holder 4 (block) to FPOINC.DAT / FCALE.DAT.
Record formats decoded from the machine's own files (Floppytools3):
 punch (231 bytes): name[6] angle f32@6 height f32@10 radius f32@14 maxton i16@18 n i16@20 start-heading f32@22
                    lengths f32@26.. (25) angles f32@126.. ; polygon from the sharp tip apex, counter clockwise,
                    heading += 180 + angle after every segment. File ends with the number of used records (i16).
 holder (180 bytes): name[6] height f32@6 n i16@10 flag i16@12 start-heading f32@14 lengths f32@18.. angles f32@98..
 die    (246 bytes): name[6] angle f32@6 sec1 f32@10 ? f32@14 height f32@18 radius f32@22 V f32@26 maxton i16@30 n i16@32
                    start-heading f32@34 lengths f32@38.. angles f32@138.. secR f32@240; outline starts at the V apex.
"""
import math, struct, sys, os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, os.pardir, 'Floppytools3')     # the NC's own export; the originals are always read from here

# ---- punch 814 outline, mm, origin = sharp tip apex, y up, from the vendor drawing (814 30.pdf), simplified to 17 segments
PUNCH = [(0, 0), (1.10, 4.105), (1.10, 17.34), (3.20, 17.34), (3.20, 92.84), (7.51, 96.81), (7.51, 121.70),
         (-7.47, 121.70), (-7.47, 151.53), (-21.45, 151.53), (-21.45, 134.15), (-18.20, 134.15), (-18.20, 126.16),
         (-21.45, 126.16), (-21.45, 109.74), (-3.21, 92.84), (-3.21, 11.980)]

def segments(pts):
    """polygon closed back to pts[0] -> lengths, angles (NC convention), first heading"""
    n = len(pts)
    L, H = [], []
    for i in range(n):
        a, b = pts[i], pts[(i + 1) % n]
        L.append(math.hypot(b[0] - a[0], b[1] - a[1]))
        H.append(math.degrees(math.atan2(b[1] - a[1], b[0] - a[0])) % 360)
    A = []
    for i in range(n):
        t = (H[(i + 1) % n] - H[i]) % 360          # left turn 0..360
        a = t - 180                                  # -165 for a 15 deg left turn, +90 for a 90 deg right turn
        if a <= -180: a += 360
        A.append(a)
    A[-1] = 0.0                                      # the last segment closes the shape, as in the machine's records
    return L, A, H[0]

def replay(L, A, h0):
    h, x, y = h0, 0.0, 0.0
    for l, a in zip(L, A):
        x += l * math.cos(math.radians(h)); y += l * math.sin(math.radians(h)); h += 180 + a
    return x, y

def punch_record(template, name, angle, height, radius, maxton, pts):
    L, A, h0 = segments(pts)
    assert len(L) <= 19, 'manual: at most 19 segments'
    ex, ey = replay(L, A, h0)
    assert math.hypot(ex, ey) < 0.05, 'outline does not close: %s' % ((ex, ey),)
    r = bytearray(template)
    r[0:6] = name.ljust(6).encode('ascii')
    struct.pack_into('<f', r, 6, angle); struct.pack_into('<f', r, 10, height); struct.pack_into('<f', r, 14, radius)
    struct.pack_into('<h', r, 18, maxton); struct.pack_into('<h', r, 20, len(L)); struct.pack_into('<f', r, 22, round(h0, 2))
    for i in range(25):
        struct.pack_into('<f', r, 26 + 4 * i, round(L[i], 2) if i < len(L) else 0.0)
    for i in range(25):
        struct.pack_into('<f', r, 126 + 4 * i, round(A[i], 2) if i < len(L) else 0.0)
    return bytes(r), L, A, h0

def holder_record(template, name, height, lengths, angles):
    r = bytearray(template)
    r[0:6] = name.ljust(6).encode('ascii')
    struct.pack_into('<f', r, 6, height); struct.pack_into('<h', r, 10, len(lengths) + 1)
    for i in range(20):
        struct.pack_into('<f', r, 18 + 4 * i, float(lengths[i]) if i < len(lengths) else 0.0)
    for i in range(20):
        struct.pack_into('<f', r, 98 + 4 * i, float(angles[i]) if i < len(angles) else 0.0)
    return bytes(r)

def main():
    # punches
    p = bytearray(open(os.path.join(SRC, 'FPOINC.DAT'), 'rb').read())
    used = struct.unpack('<h', p[-2:])[0]
    assert used == 2 and p[2 * 231 + 2:2 * 231 + 6] == b'1602', 'unexpected FPOINC.DAT layout'
    tmpl = bytes(p[231:462])                          # punch 835 as template for the bytes we do not understand
    rec, L, A, h0 = punch_record(tmpl, '814', 30.0, 120.0, 0.6, 450, PUNCH)
    p[2 * 231:3 * 231] = rec; p[-2:] = struct.pack('<h', used + 1)
    open(os.path.join(HERE, 'FPOINC.DAT'), 'wb').write(p)
    print('punch 814: %d segments, start heading %.1f' % (len(L), h0))
    for i, (l, a) in enumerate(zip(L, A)): print('  %2d  L=%7.2f  angle=%8.2f' % (i + 1, l, a))
    # holders: block 60 x 85 (same bounding box and start as holder 3)
    h = bytearray(open(os.path.join(SRC, 'FCALE.DAT'), 'rb').read())
    used = struct.unpack('<h', h[-2:])[0]
    assert used == 2 and h[180:181] == b'3', 'unexpected FCALE.DAT layout'
    rec = holder_record(bytes(h[180:360]), '4', 85.0, [60, 85, 60, 85], [-90, -90, -90, -90])
    h[360:540] = rec; h[-2:] = struct.pack('<h', used + 1)
    open(os.path.join(HERE, 'FCALE.DAT'), 'wb').write(h)
    print('holder 4: block 60 x 85')
    # dies: 3108 = die 3008 with an 85 mm block under it (the holder folded into the die), use with DH 0
    m = bytearray(open(os.path.join(SRC, 'FMATRI.DAT'), 'rb').read())
    used = struct.unpack('<h', m[-2:])[0]
    assert used == 2 and m[246:250] == b'3008', 'unexpected FMATRI.DAT layout'
    r = bytearray(m[246:492]); r[0:6] = b'3108  '
    n = struct.unpack_from('<h', r, 32)[0]
    L = [struct.unpack_from('<f', r, 38 + 4 * i)[0] for i in range(n)]
    A = [struct.unpack_from('<f', r, 138 + 4 * i)[0] for i in range(n)]
    ADD = 85.0
    assert abs(L[4] - 12.0) < 0.01 and abs(L[5] - 48.0) < 0.01 and abs(L[7] - 48.0) < 0.01     # left wall = segment 6, right wall = segment 8
    L[5] += ADD; L[7] += ADD
    struct.pack_into('<f', r, 18, struct.unpack_from('<f', r, 18)[0] + ADD)                     # height 38 -> 123
    for i in range(n): struct.pack_into('<f', r, 38 + 4 * i, L[i])
    h0 = struct.unpack_from('<f', r, 34)[0]
    ex, ey = replay(L, A, h0)
    assert math.hypot(ex, ey) < 0.05, 'die outline does not close'
    m[2 * 246:3 * 246] = r; m[-2:] = struct.pack('<h', used + 1)
    open(os.path.join(HERE, 'FMATRI.DAT'), 'wb').write(m)
    print('die 3108: 3008 + %.0f mm block, height %.0f' % (ADD, struct.unpack_from('<f', r, 18)[0]))

if __name__ == '__main__':
    main()
