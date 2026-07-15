#ifndef TAPSMITH_HID_PROTOCOL_H
#define TAPSMITH_HID_PROTOCOL_H

/* One parsed stdin command for the iOS HID helper.
 * Wire protocol (whitespace-delimited, coords in LOGICAL POINTS):
 *   d <x> <y>   touch down
 *   m <x> <y>   touch move (contact maintained)
 *   u <x> <y>   touch up
 *   c           cancel (lift at last point; x/y unused)
 *   t2 <x> <y>  double-tap primitive: the helper injects both down/up pairs
 *               with in-process timing, so the inter-tap gap stays inside
 *               every double-tap recognizer window regardless of how loaded
 *               the daemon-side event loop is (four host round-trips were
 *               observed stretching the gap past the app's window on CI)
 */
typedef enum {
  HID_DOWN,
  HID_MOVE,
  HID_UP,
  HID_CANCEL,
  HID_DOUBLE_TAP,
  HID_INVALID
} HidCmd;

typedef struct {
  HidCmd cmd;
  double x;
  double y;
} HidEvent;

/* Parse one protocol line. Returns cmd==HID_INVALID on malformed input
 * (unknown command, missing coordinate, or NULL). */
HidEvent hid_parse_line(const char *line);

/* Convert a logical-point coordinate to a normalized 0..1 ratio, clamped to
 * [0,1]. Returns 0.0 when extentPt <= 0 (divide-by-zero guard). */
double hid_normalize(double point, double extentPt);

#endif /* TAPSMITH_HID_PROTOCOL_H */
