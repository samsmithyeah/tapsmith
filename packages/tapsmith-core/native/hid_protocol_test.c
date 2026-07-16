#include "hid_protocol.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>

static int approx(double a, double b) { return fabs(a - b) < 1e-9; }

int main(void) {
  HidEvent e;

  e = hid_parse_line("d 100 200");
  assert(e.cmd == HID_DOWN && approx(e.x, 100) && approx(e.y, 200));

  e = hid_parse_line("m 12.5 34.75");
  assert(e.cmd == HID_MOVE && approx(e.x, 12.5) && approx(e.y, 34.75));

  e = hid_parse_line("u 0 0");
  assert(e.cmd == HID_UP);

  e = hid_parse_line("c");
  assert(e.cmd == HID_CANCEL);

  e = hid_parse_line("t2 150 300");
  assert(e.cmd == HID_DOUBLE_TAP && approx(e.x, 150) && approx(e.y, 300));

  e = hid_parse_line("t2");            /* missing coords -> invalid */
  assert(e.cmd == HID_INVALID);

  e = hid_parse_line("t20 1 2");       /* no delimiter after t2 -> invalid */
  assert(e.cmd == HID_INVALID);

  e = hid_parse_line("t2\t150 300");   /* tab delimiter accepted */
  assert(e.cmd == HID_DOUBLE_TAP && approx(e.x, 150) && approx(e.y, 300));

  e = hid_parse_line("t 100 200");     /* bare 't' is not a command */
  assert(e.cmd == HID_INVALID);

  e = hid_parse_line("   m 5 6");   /* leading whitespace tolerated */
  assert(e.cmd == HID_MOVE && approx(e.x, 5) && approx(e.y, 6));

  e = hid_parse_line("x 1 2");      /* unknown command */
  assert(e.cmd == HID_INVALID);

  e = hid_parse_line("d 1");        /* missing y */
  assert(e.cmd == HID_INVALID);

  e = hid_parse_line("");           /* empty */
  assert(e.cmd == HID_INVALID);

  /* normalize + clamp to [0,1] */
  assert(approx(hid_normalize(100, 200), 0.5));
  assert(approx(hid_normalize(-10, 200), 0.0));   /* clamp low */
  assert(approx(hid_normalize(300, 200), 1.0));   /* clamp high */
  assert(approx(hid_normalize(5, 0), 0.0));       /* guard divide-by-zero */

  printf("all hid_protocol tests passed\n");
  return 0;
}
