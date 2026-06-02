// tapsmith-ios-hid.m — long-running iOS Simulator HID touch injector.
//
// Usage: tapsmith-ios-hid <udid>
//
// On startup: dlopen CoreSimulator + SimulatorKit, resolve the SimDevice for
// <udid>, open ONE persistent SimulatorKit.SimDeviceLegacyHIDClient, query the
// device screen size+scale, then print "ready <wPx> <hPx> <scale>" to stdout.
//
// Then loop on stdin, one event per line (coords in LOGICAL POINTS):
//   d <x> <y>   touch down       m <x> <y>   touch move (contact held)
//   u <x> <y>   touch up          c           cancel (lift at last point)
// Prints "ok" or "err <msg>" per line. Exits 0 on stdin EOF.
// Startup failure: prints "fatal <msg>" to stderr and exits 1.
//
// HID mechanism is verbatim from the proven spike docs/superpowers/spikes/
// ios-hid/hidpoke.m (SimDeviceLegacyHIDClient + Indigo 320-byte message).
//
// Build (see build.rs): clang -fobjc-arc -framework Foundation \
//   -framework CoreGraphics -o tapsmith-ios-hid tapsmith-ios-hid.m hid_protocol.c
// (CoreSimulator/SimulatorKit are dlopen'd at runtime; not linked.)

#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <dlfcn.h>
#import <mach/mach_time.h>
#include "hid_protocol.h"

#pragma pack(push, 4)
typedef struct {
  unsigned int msgh_bits, msgh_size, msgh_remote_port, msgh_local_port,
      msgh_voucher_port;
  int msgh_id;
} MachMessageHeader;

typedef struct {
  unsigned int field1, field2, field3;
  double xRatio, yRatio, field6, field7, field8;
  unsigned int field9, field10, field11, field12, field13;
  double field14, field15, field16, field17, field18;
} IndigoTouch;

typedef struct {
  unsigned int field1;
  unsigned long long timestamp;
  unsigned int field3;
  IndigoTouch touch;
} IndigoPayload;

typedef struct {
  MachMessageHeader header;
  unsigned int innerSize;
  unsigned char eventType;
  IndigoPayload payload;
} IndigoMessage;
#pragma pack(pop)

enum { DirDown = 1, DirUp = 2 };

typedef IndigoMessage *(*MouseNSEventFn)(CGPoint *, CGPoint *, int, int, BOOL);
static MouseNSEventFn gMouseFn = NULL;

// Build the canonical 320-byte touch Indigo message (verbatim from the spike).
static IndigoMessage *makeTouchMessage(double xRatio, double yRatio, int direction) {
  CGPoint p = CGPointMake(xRatio, yRatio);
  IndigoMessage *base = gMouseFn(&p, NULL, 0x32, direction, 0x0);
  base->payload.touch.xRatio = xRatio;
  base->payload.touch.yRatio = yRatio;

  IndigoTouch *payload = &base->payload.touch;
  size_t messageSize = sizeof(IndigoMessage) + sizeof(IndigoPayload);
  size_t stride = sizeof(IndigoPayload);

  IndigoMessage *message = calloc(1, messageSize);
  message->innerSize = sizeof(IndigoPayload);
  message->eventType = 0x02;
  message->payload.field1 = 0x0000000b;
  message->payload.timestamp = mach_absolute_time();
  memcpy(&message->payload.touch, payload, sizeof(IndigoTouch));
  free(base);

  unsigned char *bp = (unsigned char *)&message->payload;
  IndigoPayload *second = (IndigoPayload *)(bp + stride);
  memcpy(second, bp, stride);
  second->touch.field1 = 0x00000001;
  second->touch.field2 = 0x00000002;
  return message;
}

static id msgSend_id(id self, SEL op) {
  return ((id(*)(id, SEL))objc_msgSend)(self, op);
}

int main(int argc, char **argv) {
  @autoreleasepool {
    if (argc < 2) { fprintf(stderr, "fatal usage: %s <udid>\n", argv[0]); return 1; }
    NSString *udid = [NSString stringWithUTF8String:argv[1]];

    const char *devDir = getenv("DEVELOPER_DIR");
    if (!devDir) devDir = "/Applications/Xcode.app/Contents/Developer";

    void *cs = dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW);
    if (!cs) { fprintf(stderr, "fatal dlopen CoreSimulator: %s\n", dlerror()); return 1; }
    Class SimServiceContext = NSClassFromString(@"SimServiceContext");
    if (!SimServiceContext) { fprintf(stderr, "fatal no SimServiceContext\n"); return 1; }

    NSString *skPath = [NSString stringWithFormat:@"%s/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit", devDir];
    void *sk = dlopen(skPath.UTF8String, RTLD_NOW);
    if (!sk) { fprintf(stderr, "fatal dlopen SimulatorKit: %s\n", dlerror()); return 1; }
    gMouseFn = (MouseNSEventFn)dlsym(sk, "IndigoHIDMessageForMouseNSEvent");
    if (!gMouseFn) { fprintf(stderr, "fatal no IndigoHIDMessageForMouseNSEvent\n"); return 1; }

    NSError *err = nil;
    SEL sctxSel = NSSelectorFromString(@"sharedServiceContextForDeveloperDir:error:");
    id sctx = ((id(*)(id, SEL, id, NSError **))objc_msgSend)(
        SimServiceContext, sctxSel, [NSString stringWithUTF8String:devDir], &err);
    if (!sctx) { fprintf(stderr, "fatal sharedServiceContext: %s\n", err.description.UTF8String); return 1; }

    id deviceSet = ((id(*)(id, SEL, NSError **))objc_msgSend)(
        sctx, NSSelectorFromString(@"defaultDeviceSetWithError:"), &err);
    if (!deviceSet) { fprintf(stderr, "fatal defaultDeviceSet: %s\n", err.description.UTF8String); return 1; }

    NSArray *devices = msgSend_id(deviceSet, NSSelectorFromString(@"devices"));
    id device = nil;
    for (id d in devices) {
      id u = msgSend_id(d, NSSelectorFromString(@"UDID"));
      NSString *us = msgSend_id(u, NSSelectorFromString(@"UUIDString"));
      if ([us caseInsensitiveCompare:udid] == NSOrderedSame) { device = d; break; }
    }
    if (!device) { fprintf(stderr, "fatal device %s not found\n", udid.UTF8String); return 1; }

    id deviceType = msgSend_id(device, NSSelectorFromString(@"deviceType"));
    CGSize screenPx = ((CGSize(*)(id, SEL))objc_msgSend)(deviceType, NSSelectorFromString(@"mainScreenSize"));
    float scale = ((float(*)(id, SEL))objc_msgSend)(deviceType, NSSelectorFromString(@"mainScreenScale"));
    if (scale <= 0) scale = 1;
    double widthPt = screenPx.width / scale;
    double heightPt = screenPx.height / scale;

    NSBundle *skBundle = [NSBundle bundleWithIdentifier:@"com.apple.SimulatorKit"];
    [skBundle loadAndReturnError:nil];
    Class hidClientClass = objc_lookUpClass("SimulatorKit.SimDeviceLegacyHIDClient");
    if (!hidClientClass) { fprintf(stderr, "fatal no SimDeviceLegacyHIDClient\n"); return 1; }
    id hidClient = [hidClientClass alloc];
    hidClient = ((id(*)(id, SEL, id, NSError **))objc_msgSend)(
        hidClient, NSSelectorFromString(@"initWithDevice:error:"), device, &err);
    if (!hidClient) { fprintf(stderr, "fatal initWithDevice: %s\n", err.description.UTF8String); return 1; }

    SEL sendSel = NSSelectorFromString(@"sendWithMessage:freeWhenDone:completionQueue:completion:");
    dispatch_queue_t cq = dispatch_queue_create("tapsmith.hid.cq", DISPATCH_QUEUE_SERIAL);

    BOOL (^sendTouch)(double, double, int) = ^BOOL(double rx, double ry, int dir) {
      IndigoMessage *m = makeTouchMessage(rx, ry, dir);
      __block NSError *serr = nil;
      dispatch_semaphore_t sem = dispatch_semaphore_create(0);
      void (^completion)(NSError *) = ^(NSError *e) { serr = e; dispatch_semaphore_signal(sem); };
      ((void(*)(id, SEL, IndigoMessage *, BOOL, dispatch_queue_t, void(^)(NSError *)))objc_msgSend)(
          hidClient, sendSel, m, YES, cq, completion);
      // A timeout must NOT be reported as success: on timeout serr is still nil
      // (the completion never fired) but the event was not delivered, so check
      // the wait's return code too. If the block fires late it safely writes to
      // the ARC-retained __block serr box and signals an unwaited semaphore — a
      // harmless no-op nobody reads.
      long rc = dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
      return rc == 0 && serr == nil;
    };

    // Announce readiness; the daemon reads this line to confirm the helper is up.
    printf("ready %.0f %.0f %.1f\n", screenPx.width, screenPx.height, scale);
    fflush(stdout);

    // Process stdin events. Track the last point so a bare `c` can lift there.
    double lastX = 0, lastY = 0;
    char buf[256];
    while (fgets(buf, sizeof(buf), stdin)) {
      HidEvent ev = hid_parse_line(buf);
      BOOL ok = NO;
      switch (ev.cmd) {
        case HID_DOWN:
        case HID_MOVE:  // moves keep contact: same DirDown direction as the spike
          lastX = ev.x; lastY = ev.y;
          ok = sendTouch(hid_normalize(ev.x, widthPt), hid_normalize(ev.y, heightPt), DirDown);
          break;
        case HID_UP:
          lastX = ev.x; lastY = ev.y;
          ok = sendTouch(hid_normalize(ev.x, widthPt), hid_normalize(ev.y, heightPt), DirUp);
          break;
        case HID_CANCEL:
          ok = sendTouch(hid_normalize(lastX, widthPt), hid_normalize(lastY, heightPt), DirUp);
          break;
        case HID_INVALID:
          printf("err invalid line\n"); fflush(stdout);
          continue;
      }
      printf(ok ? "ok\n" : "err send failed\n");
      fflush(stdout);
    }
    return 0;
  }
}
