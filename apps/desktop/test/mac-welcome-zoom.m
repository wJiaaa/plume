#import "../src/main/mac-welcome-zoom.m"
#include <assert.h>

@interface TestWindowDelegate : NSObject<NSWindowDelegate>
@property int zooms;
@end
@implementation TestWindowDelegate
- (BOOL)windowShouldClose:(NSWindow *)sender { return NO; }
- (BOOL)windowShouldZoom:(NSWindow *)window toFrame:(NSRect)frame { self.zooms += 1; return YES; }
@end

static unsigned lastRequest;
static void recordRequest(unsigned request) { lastRequest = request; }
static unsigned settleRequest;
static void recordSettle(unsigned request, double width, double height, int mode) { settleRequest = request; }

static NSImage *blankImage(NSSize size) {
    return [NSImage imageWithSize:size flipped:YES drawingHandler:^BOOL(NSRect area) {
        [NSColor.windowBackgroundColor setFill];
        NSRectFill(area);
        return YES;
    }];
}

static void spin(double seconds) { CFRunLoopRunInMode(kCFRunLoopDefaultMode, seconds, false); }

static NSWindow *makeWindow(TestWindowDelegate *delegate) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(120, 120, 800, 600)
                                                   styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskResizable | NSWindowStyleMaskFullSizeContentView
                                                     backing:NSBackingStoreBuffered
                                                       defer:NO];
    window.releasedWhenClosed = NO;
    window.delegate = delegate;
    return window;
}

/** 一块不动的、一块横向拉开的、一块整块平移的；拉开的那条是 1 点宽。 */
static void deliverSnapshot(NSWindow *window) {
    requestPreview();
    double tiles[] = {
        0, 0, 100, 600, 0, 0, 100, 600, 0, 0, 0, 0, 0,
        100, 0, 1, 600, 100, 0, 1, 600, 0, 1, 0, 0, 0,
        101, 0, 699, 600, 101, 0, 699, 600, 1, 0, 0, 0, 0,
    };
    plume_prepare_zoom(lastRequest, (__bridge void *)blankImage(window.contentView.bounds.size), tiles, 3);
}

static void checkDelegate(void) {
    TestWindowDelegate *original = [TestWindowDelegate new];
    NSWindow *window = makeWindow(original);
    plume_watch_zoom((__bridge void *)window.contentView, 40, recordRequest, recordSettle);
    assert(window.delegate == original && [window.delegate isKindOfClass:TestWindowDelegate.class]);
    assert(![window.delegate windowShouldClose:window]);
    // 没有截图：缩放、全屏都照常交给原来的代理和系统。
    assert([window.delegate windowShouldZoom:window toFrame:NSMakeRect(0, 0, 1000, 700)] && original.zooms == 1);
    if (window.screen) assert(![window.delegate customWindowsToEnterFullScreenForWindow:window onScreen:window.screen]);
    if (window.screen && !reduceMotion()) {
        deliverSnapshot(window);
        // 过渡窗口先建好、透明地一起交给系统，才会跟着主窗口搬到全屏的桌面。
        NSArray *windows = [window.delegate customWindowsToEnterFullScreenForWindow:window onScreen:window.screen];
        assert(windows.count == 2 && windows[0] == window && windows[1] == fullscreenOverlay && fullscreenOverlay.alphaValue == 0);
        assert(NSEqualRects(windowedFrame, window.frame));
        // 全屏期间屏幕变小、原来的窗框放不下了：退出交给系统。
        windowedFrame = NSOffsetRect(window.screen.frame, window.screen.frame.size.width, 0);
        assert(![window.delegate customWindowsToExitFullScreenForWindow:window]);
        // 没切成时放回原样。
        windowedFrame = window.frame;
        [window setFrame:NSOffsetRect(windowedFrame, 40, 40) display:NO];
        [window.delegate windowDidFailToEnterFullScreen:window];
        assert(NSEqualRects(window.frame, windowedFrame) && !fullscreenOverlay);
    }
    plume_unwatch_zoom();
    assert(object_getClass(original) == TestWindowDelegate.class);
}

/** 截图能不能用：尺寸变过、过期的不用；能拉的空白不够缩时也不用。 */
static void checkReady(void) {
    TestWindowDelegate *delegate = [TestWindowDelegate new];
    NSWindow *window = makeWindow(delegate);
    plume_watch_zoom((__bridge void *)window.contentView, 40, recordRequest, recordSettle);
    deliverSnapshot(window);
    unsigned stale = lastRequest;
    assert(readyFor(NSMakeSize(1000, 700)));
    assert(readyFor(NSMakeSize(799, 600)));
    assert(!readyFor(NSMakeSize(700, 600)));
    plume_prepare_zoom(stale, NULL, NULL, 0);
    assert(readyImage);
    [window setContentSize:NSMakeSize(900, 600)];
    assert(!readyFor(NSMakeSize(1000, 700)));
    plume_unwatch_zoom();
}

/** 过渡：盖上过渡窗口、主窗口藏起来；页面画好且动画走完才换回来。 */
static void checkTransition(void) {
    TestWindowDelegate *delegate = [TestWindowDelegate new];
    NSWindow *window = makeWindow(delegate);
    [window orderFront:nil];
    plume_watch_zoom((__bridge void *)window.contentView, 40, recordRequest, recordSettle);
    deliverSnapshot(window);
    assert(beginTransition(window, NSMakeSize(1000, 700), -1));
    assert(overlay && overlay.isVisible && window.alphaValue == 0 && !readyImage);
    unsigned request = transitionRequest;
    plume_page_settled(request, true);
    spin(0.05);
    assert(overlay && window.alphaValue == 0);
    animationDone = YES;
    trySwap();
    assert(!overlay && window.alphaValue == 1);
    plume_page_settled(request, true);
    spin(0.05);
    assert(!overlay);
    plume_unwatch_zoom();
    [window orderOut:nil];
}

/** 等着截图的全屏动画不在页面交图的那次调用里开始，放到主队列下一轮。 */
static void checkAsyncStart(void) {
    TestWindowDelegate *delegate = [TestWindowDelegate new];
    NSWindow *window = makeWindow(delegate);
    plume_watch_zoom((__bridge void *)window.contentView, 40, recordRequest, recordSettle);
    __block BOOL started = NO;
    startFullscreen = ^{ started = YES; startFullscreen = nil; };
    requestPreview();
    plume_prepare_zoom(lastRequest, NULL, NULL, 0);
    assert(!started);
    spin(0.05);
    assert(started);
    plume_unwatch_zoom();
}

/** 摆截图：不动的不动，拉伸的只变宽，平移的整块挪；裁切的变矮时裁掉、变高时不长；填充的变矮时收成 0。 */
static void checkTiles(void) {
    PlumeTile list[] = {
        {CGRectMake(0, 0, 100, 600), CGRectMake(0, 0, 100, 600), 0, 0, 0, 0, 0},
        {CGRectMake(100, 0, 1, 600), CGRectMake(100, 0, 1, 600), 0, 1, 0, 0, 0},
        {CGRectMake(101, 0, 699, 600), CGRectMake(101, 0, 699, 600), 1, 0, 0, 0, 0},
        {CGRectMake(0, 0, 50, 300), CGRectMake(0, 0, 50, 300), 0, 0, 0, 1, TileCrop},
        {CGRectMake(0, 200, 50, 1), CGRectMake(0, 300, 50, 0), 0, 0, 0, 1, TileClamp},
        {CGRectMake(0, 300, 50, 300), CGRectMake(0, 300, 50, 300), 0, 0, 1, 0, 0},
    };
    NSData *tiles = [NSData dataWithBytes:list length:sizeof list];
    CGImageRef pixels = [blankImage(NSMakeSize(800, 600)) CGImageForProposedRect:NULL context:nil hints:nil];
    PlumeTransitionView *view = [[PlumeTransitionView alloc] initWithFrame:NSMakeRect(0, 0, 800, 600) pixels:pixels tiles:tiles reach:NSMakeSize(1200, 800)];
    assert(view.layer.sublayers.count == 6);
    for (int step = -100; step <= 200; step += 7) {
        CGFloat dw = step * 2, dh = step;
        [view setFrameSize:NSMakeSize(800 + dw, 600 + dh)];
        NSArray<CALayer *> *layers = view.layer.sublayers;
        assert(CGRectEqualToRect(layers[0].frame, CGRectMake(0, 0, 100, 600)));
        assert(CGRectGetMinX(layers[1].frame) == 100 && fabs(CGRectGetWidth(layers[1].frame) - MAX(0, 1 + dw)) <= 0.5);
        assert(fabs(CGRectGetMinX(layers[2].frame) - (101 + dw)) <= 0.5 && CGRectGetWidth(layers[2].frame) == 699);
        assert(fabs(CGRectGetHeight(layers[3].frame) - MIN(300, 300 + dh)) <= 0.5);
        assert(fabs(CGRectGetHeight(layers[4].frame) - MAX(0, dh)) <= 0.5 && CGRectGetMinY(layers[4].frame) == 300);
        assert(fabs(CGRectGetMinY(layers[5].frame) - (300 + dh)) <= 0.5 && CGRectGetHeight(layers[5].frame) == 300);
        // 相邻两块之间不留缝、不重叠。
        assert(CGRectGetMaxX(layers[1].frame) == CGRectGetMinX(layers[2].frame) || dw <= -1);
        assert([view hitTest:NSMakePoint(50, 50)] == nil);
    }
}

/** 一块 100 点见方、前半红后半蓝的图拉到三倍：平铺的话 220 处是第三份的前半（红），放大的话是后半（蓝）。 */
static void checkRepeat(BOOL tall) {
    NSImage *halves = [NSImage imageWithSize:NSMakeSize(100, 100) flipped:YES drawingHandler:^BOOL(NSRect area) {
        [NSColor.redColor setFill];
        NSRectFill(tall ? NSMakeRect(0, 0, 100, 50) : NSMakeRect(0, 0, 50, 100));
        [NSColor.blueColor setFill];
        NSRectFill(tall ? NSMakeRect(0, 50, 100, 50) : NSMakeRect(50, 0, 50, 100));
        return YES;
    }];
    PlumeTile tile = {CGRectMake(0, 0, 100, 100), CGRectMake(0, 0, 100, 100), 0, tall ? 0 : 1, 0, tall ? 1 : 0, 0};
    NSSize end = tall ? NSMakeSize(100, 300) : NSMakeSize(300, 100);
    PlumeTransitionView *view = [[PlumeTransitionView alloc] initWithFrame:NSMakeRect(0, 0, 100, 100)
                                                                    pixels:[halves CGImageForProposedRect:NULL context:nil hints:nil]
                                                                     tiles:[NSData dataWithBytes:&tile length:sizeof tile]
                                                                     reach:end];
    [view setFrameSize:end];
    NSBitmapImageRep *rep = [view bitmapImageRepForCachingDisplayInRect:view.bounds];
    CGFloat k = rep.pixelsWide / end.width;
    // 视图是翻转的，位图不是：先翻过来再画，位图的行（从上往下数）才和视图里的 y 对上。
    CGContextRef context = [NSGraphicsContext graphicsContextWithBitmapImageRep:rep].CGContext;
    CGContextTranslateCTM(context, 0, end.height);
    CGContextScaleCTM(context, 1, -1);
    [view.layer renderInContext:context];
    CGFloat (^red)(int) = ^CGFloat(int along) {
        NSColor *color = tall ? [rep colorAtX:(NSInteger)(50 * k) y:(NSInteger)(along * k)] : [rep colorAtX:(NSInteger)(along * k) y:(NSInteger)(50 * k)];
        return [color colorUsingColorSpace:NSColorSpace.sRGBColorSpace].redComponent;
    };
    assert(red(20) > 0.5 && red(80) < 0.5 && red(220) > 0.5 && red(280) < 0.5);
}

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        checkTiles();
        checkRepeat(NO);
        checkRepeat(YES);
        checkDelegate();
        checkReady();
        checkTransition();
        checkAsyncStart();
    }
}
