#include "hid_protocol.h"
#include <ctype.h>
#include <stdlib.h>

static double clamp01(double v) {
  if (v < 0.0) return 0.0;
  if (v > 1.0) return 1.0;
  return v;
}

double hid_normalize(double point, double extentPt) {
  if (extentPt <= 0.0) return 0.0;
  return clamp01(point / extentPt);
}

HidEvent hid_parse_line(const char *line) {
  HidEvent e = { HID_INVALID, 0.0, 0.0 };
  if (!line) return e;

  while (*line && isspace((unsigned char)*line)) line++;
  char c = *line;

  if (c == 'c') { e.cmd = HID_CANCEL; return e; }
  if (c != 'd' && c != 'm' && c != 'u') return e;

  const char *rest = line + 1;
  char *end = NULL;
  double x = strtod(rest, &end);
  if (end == rest) return e;          /* no x parsed */
  const char *rest2 = end;
  double y = strtod(rest2, &end);
  if (end == rest2) return e;         /* no y parsed */

  e.x = x;
  e.y = y;
  e.cmd = (c == 'd') ? HID_DOWN : (c == 'm') ? HID_MOVE : HID_UP;
  return e;
}
