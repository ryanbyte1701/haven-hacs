"""Color helpers shared by the Hue and MQTT light code.

CIE xy <-> sRGB hex (Wide-gamut D65 matrices as used by Philips Hue), mirek <-> Kelvin.
"""
from __future__ import annotations


def mirek_to_kelvin(m: float) -> int:
    return int(round(1_000_000 / max(1.0, float(m))))


def kelvin_to_mirek(k: float) -> int:
    return int(round(1_000_000 / max(1.0, float(k))))


def _gamma(c: float) -> float:          # linear -> sRGB
    c = max(0.0, c)
    return 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055


def _inv_gamma(c: float) -> float:      # sRGB -> linear
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def xy_to_hex(x: float, y: float) -> str:
    """Full-brightness sRGB color for a CIE xy point; out-of-gamut values are scaled, not clipped badly."""
    y = max(float(y), 1e-6)
    Y = 1.0
    X = (Y / y) * x
    Z = (Y / y) * (1 - x - y)
    r = X * 1.656492 - Y * 0.354851 - Z * 0.255038
    g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152
    b = X * 0.051713 - Y * 0.121364 + Z * 1.011530
    # negatives -> 0, then normalise so the brightest channel is 1 (keeps hue)
    r, g, b = (max(0.0, v) for v in (r, g, b))
    m = max(r, g, b) or 1.0
    r, g, b = (_gamma(v / m) for v in (r, g, b))
    m = max(r, g, b, 1.0)
    return "#{:02x}{:02x}{:02x}".format(*(int(round(255 * min(1.0, v / m))) for v in (r, g, b)))


def hex_to_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    if len(h) != 6:
        raise ValueError(f"bad color {h!r}")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def rgb_to_hex(r: float, g: float, b: float) -> str:
    return "#{:02x}{:02x}{:02x}".format(*(max(0, min(255, int(round(v)))) for v in (r, g, b)))


def hex_to_xy(h: str) -> tuple[float, float]:
    r, g, b = (_inv_gamma(v / 255) for v in hex_to_rgb(h))
    X = r * 0.664511 + g * 0.154324 + b * 0.162028
    Y = r * 0.283881 + g * 0.668433 + b * 0.047685
    Z = r * 0.000088 + g * 0.072310 + b * 0.986039
    s = X + Y + Z
    if s == 0:
        return 0.3227, 0.329   # white point
    return round(X / s, 4), round(Y / s, 4)


def hs_to_hex(h: float, s: float) -> str:
    import colorsys
    r, g, b = colorsys.hsv_to_rgb((float(h) % 360) / 360, max(0.0, min(100.0, float(s))) / 100, 1.0)
    return rgb_to_hex(r * 255, g * 255, b * 255)
