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
  HidEvent e = { .cmd = HID_INVALID, .x = 0.0, .y = 0.0 };
  if (!line) return e;

  while (*line && isspace((unsigned char)*line)) line++;
  char c = *line;

  if (c == 'c') { e.cmd = HID_CANCEL; return e; }

  int isDoubleTap = (c == 't' && line[1] == '2');
  if (!isDoubleTap && c != 'd' && c != 'm' && c != 'u') return e;

  const char *rest = line + (isDoubleTap ? 2 : 1);
  char *end = NULL;
  double x = strtod(rest, &end);
  if (end == rest) return e;          /* no x parsed */
  const char *rest2 = end;
  double y = strtod(rest2, &end);
  if (end == rest2) return e;         /* no y parsed */

  e.x = x;
  e.y = y;
  e.cmd = isDoubleTap ? HID_DOUBLE_TAP
        : (c == 'd')  ? HID_DOWN
        : (c == 'm')  ? HID_MOVE
                      : HID_UP;
  return e;
}
