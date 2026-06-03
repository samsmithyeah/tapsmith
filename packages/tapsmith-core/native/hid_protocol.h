#ifndef TAPSMITH_HID_PROTOCOL_H
#define TAPSMITH_HID_PROTOCOL_H

/* One parsed stdin command for the iOS HID helper.
 * Wire protocol (whitespace-delimited, coords in LOGICAL POINTS):
 *   d <x> <y>   touch down
 *   m <x> <y>   touch move (contact maintained)
 *   u <x> <y>   touch up
 *   c           cancel (lift at last point; x/y unused)
 */
typedef enum {
  HID_DOWN,
  HID_MOVE,
  HID_UP,
  HID_CANCEL,
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
