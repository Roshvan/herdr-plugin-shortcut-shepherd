ObjC.import("CoreGraphics");
ObjC.import("unistd");
const parent = $.getppid();
const out = $.NSFileHandle.fileHandleWithStandardOutput;
const KEY = [10, 12];
const MOUSE = [1, 3, 6, 22, 25];
const ago = (type) => $.CGEventSourceSecondsSinceLastEventType(0, type) * 1000;
const lastOf = (types) => Math.min(...types.map(ago));
const emit = (kind, at) => out.writeData($.NSString.alloc.initWithUTF8String(kind + " " + Math.round(at) + "\n").dataUsingEncoding($.NSUTF8StringEncoding));
let lastKey = -1;
let lastMouse = -1;
try {
  for (;;) {
    if ($.getppid() !== parent) break;
    const now = Date.now();
    const key = now - lastOf(KEY);
    const mouse = now - lastOf(MOUSE);
    if (Math.abs(key - lastKey) > 20) { lastKey = key; emit("k", key); }
    if (Math.abs(mouse - lastMouse) > 20) { lastMouse = mouse; emit("m", mouse); }
    delay(0.05);
  }
} catch (error) {}
