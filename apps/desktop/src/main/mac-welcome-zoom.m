#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>

/*
 * 欢迎页的放大、还原、进出全屏：动画期间不让页面跟着窗框一帧帧重排。
 *
 * Electron 的窗口每改一次尺寸，Chromium 都要重新排版出帧，主线程被它拖着，窗框只能几十毫秒挪一步，里面的东西就一顿一顿地跳。
 * 这里换成：按下顶行（双击的第一下、绿色按钮）时先截下整页，页面同时说明每一块在窗口变大变小时怎么挪（见 mac-welcome-zoom.ts 的
 * `transitionLayout`）。动画开始时在主窗口上面盖一个外观一样的过渡窗口，里面按当帧尺寸摆这些截图块，只动现成的图层；主窗口藏起来、
 * 一次跳到终点尺寸，页面在后面只排一次版。过渡窗口按系统的时长和曲线走完，等页面在终点尺寸画好、核对过每一块都在预料的位置，
 * 再把主窗口亮出来、撤掉过渡窗口；对不上（比如全屏后顶行按钮让出了红绿灯的位置）就用很短的淡出交接，不硬切。
 */

enum { TileCrop = 1, TileClamp = 2 };
/** 一块截图：`image` 是截图里的区域，`frame` 是它在起点尺寸时的位置；窗口宽高变了 dw、dh 时，位置加 (tx·dw, ty·dh)、尺寸加 (sx·dw, sy·dh)。 */
typedef struct {
    CGRect image;
    CGRect frame;
    double tx, sx, ty, sy;
    int flags;
} PlumeTile;
enum { TileFields = 13 };

@interface PlumeTransitionView : NSView
- (instancetype)initWithFrame:(NSRect)frame pixels:(CGImageRef)pixels tiles:(NSData *)tiles reach:(NSSize)reach;
@end

/*
 * 每块是一个裁边的框，里面放一张不动的图，框变小就裁掉右边、下边。会拉开的块不把截图放大，而是沿拉开的方向重复摆到
 * 终点要的长度：拉开的那一段本来就是纯色或平铺的磨砂，重复出来和真实页面一样，放大的话噪点会糊、单行的噪点会拉成竖纹。
 */
@implementation PlumeTransitionView {
    CGFloat _scale;
    NSSize _original;
    NSData *_tiles;
    NSArray<CALayer *> *_layers;
}
- (instancetype)initWithFrame:(NSRect)frame pixels:(CGImageRef)pixels tiles:(NSData *)tiles reach:(NSSize)reach {
    self = [super initWithFrame:frame];
    self.wantsLayer = YES;
    _original = frame.size;
    _scale = CGImageGetWidth(pixels) / frame.size.width;
    _tiles = tiles;
    NSUInteger count = tiles.length / sizeof(PlumeTile);
    CGFloat dw = reach.width - frame.size.width, dh = reach.height - frame.size.height;
    const PlumeTile *list = tiles.bytes;
    NSMutableArray *layers = [NSMutableArray arrayWithCapacity:count];
    for (NSUInteger index = 0; index < count; ++index) {
        PlumeTile tile = list[index];
        BOOL wide = tile.sx != 0, tall = tile.sy != 0 && !(tile.flags & TileCrop);
        CGSize size = CGSizeMake(MAX(tile.image.size.width, wide ? tile.frame.size.width + tile.sx * MAX(0, dw) : 0),
                                 MAX(tile.image.size.height, tall ? tile.frame.size.height + tile.sy * MAX(0, dh) : 0));
        CALayer *box = [CALayer layer];
        box.masksToBounds = YES;
        CALayer *picture = [CALayer layer];
        picture.contentsScale = _scale;
        picture.frame = CGRectMake(0, 0, tile.image.size.width, tile.image.size.height);
        CGImageRef image = [self image:pixels rect:tile.image];
        picture.contents = (__bridge id)image;
        if (image) CGImageRelease(image);
        // 由合成器照着同一张图重复画，不在主线程上生成大位图。
        if (wide && size.width > tile.image.size.width && tile.image.size.width > 0)
            picture = [self repeat:picture count:ceil(size.width / tile.image.size.width) step:CGSizeMake(tile.image.size.width, 0)];
        if (tall && size.height > tile.image.size.height && tile.image.size.height > 0)
            picture = [self repeat:picture count:ceil(size.height / tile.image.size.height) step:CGSizeMake(0, tile.image.size.height)];
        [box addSublayer:picture];
        [self.layer addSublayer:box];
        [layers addObject:box];
    }
    _layers = layers;
    [self layoutTiles];
    return self;
}
- (BOOL)isFlipped { return YES; }
- (NSView *)hitTest:(NSPoint)point { return nil; }
- (CGImageRef)image:(CGImageRef)pixels rect:(CGRect)rect CF_RETURNS_RETAINED {
    CGRect area = CGRectMake(round(rect.origin.x * _scale), round(rect.origin.y * _scale), round(rect.size.width * _scale), round(rect.size.height * _scale));
    return area.size.width >= 1 && area.size.height >= 1 ? CGImageCreateWithImageInRect(pixels, area) : NULL;
}
/** 把 `layer` 沿 `step` 接着摆 `count` 份，从它所在的左上角起。 */
- (CALayer *)repeat:(CALayer *)layer count:(CGFloat)count step:(CGSize)step {
    CAReplicatorLayer *row = [CAReplicatorLayer layer];
    row.frame = CGRectMake(0, 0, layer.bounds.size.width + step.width * (count - 1), layer.bounds.size.height + step.height * (count - 1));
    row.instanceCount = (NSInteger)count;
    row.instanceTransform = CATransform3DMakeTranslation(step.width, step.height, 0);
    [row addSublayer:layer];
    return row;
}
- (void)setFrameSize:(NSSize)size {
    [super setFrameSize:size];
    [self layoutTiles];
}
/** 边按设备像素取整：相邻两块共用同一条边的算式，取整后也严丝合缝，不露缝。 */
- (CGFloat)snap:(CGFloat)value { return round(value * _scale) / _scale; }
- (void)layoutTiles {
    CGFloat dw = self.bounds.size.width - _original.width, dh = self.bounds.size.height - _original.height;
    const PlumeTile *list = _tiles.bytes;
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    for (NSUInteger index = 0; index < _layers.count; ++index) {
        PlumeTile tile = list[index];
        CGFloat left = tile.frame.origin.x + tile.tx * dw, top = tile.frame.origin.y + tile.ty * dh;
        CGFloat right = left + tile.frame.size.width + tile.sx * dw, bottom = top + tile.frame.size.height + tile.sy * dh;
        // 只裁不拉：变矮时从下面裁掉（像滚动区收短），变高时保持原样，下面让给填充块。
        if (tile.flags & TileCrop) bottom = top + MIN(tile.frame.size.height, bottom - top);
        CGFloat x0 = [self snap:left], x1 = [self snap:right], y0 = [self snap:top], y1 = [self snap:bottom];
        _layers[index].frame = CGRectMake(x0, y0, MAX(0, x1 - x0), MAX(0, y1 - y0));
    }
    [CATransaction commit];
}
@end

/** 过渡窗口：和主窗口一样的圆角、阴影和红绿灯。不接收点击、不抢焦点；红绿灯照激活时的样子画。 */
@interface PlumeTransitionWindow : NSWindow
@end

@implementation PlumeTransitionWindow
- (BOOL)canBecomeKeyWindow { return NO; }
- (BOOL)canBecomeMainWindow { return NO; }
- (BOOL)isKeyWindow { return YES; }
- (BOOL)isMainWindow { return YES; }
// 全屏的终点盖住菜单栏那一条；标题栏窗口默认会被挤到菜单栏下面。
- (NSRect)constrainFrameRect:(NSRect)frameRect toScreen:(NSScreen *)screen { return frameRect; }
@end

static id clickMonitor;
static __weak NSWindow *watchedWindow;
static __weak id installedDelegate;
static Class delegateClass;
static IMP baseShouldZoom, baseFailEnter, baseFailExit, baseResizeTime;
static BOOL passZoom, instantResize;
static void (*requestSnapshot)(unsigned);
static void (*settlePage)(unsigned, double, double, int);

static unsigned serial;
static unsigned pendingRequest;
static NSTimeInterval pendingAt;
static CGImageRef readyImage;
static NSData *readyTiles;
static NSSize readySize;
static NSTimeInterval readyAt;

static PlumeTransitionWindow *overlay;
static unsigned transitionRequest;
static BOOL animationDone, pageSettled, pageMatched;
static NSSize transitionFrom, transitionTo;
static int transitionMode;
static NSRect buttonRects[3];
static CGFloat titlebarHeight;
static BOOL zoomWaiting;
static NSRect waitingZoom;
static void (^startFullscreen)(void);

static NSRect windowedFrame;
static NSRect fullscreenFrame;
static NSNumber *originalDisplay;

static NSTimeInterval now(void) { return NSProcessInfo.processInfo.systemUptime; }
static BOOL reduceMotion(void) { return NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion; }

static void dropReady(void) {
    if (readyImage) CGImageRelease(readyImage);
    readyImage = NULL;
    readyTiles = nil;
}

/** 截好的整页还能不能用在这次尺寸变化上：没过期、截图之后窗口没变过，而且每一块可拉伸的空白都够缩。 */
static BOOL readyFor(NSSize target) {
    NSView *root = watchedWindow.contentView;
    if (!readyImage || !root || now() - readyAt > NSEvent.doubleClickInterval + 0.5 || !NSEqualSizes(root.bounds.size, readySize)) return NO;
    CGFloat dw = target.width - readySize.width, dh = target.height - readySize.height;
    const PlumeTile *list = readyTiles.bytes;
    for (NSUInteger index = 0; index < readyTiles.length / sizeof(PlumeTile); ++index) {
        PlumeTile tile = list[index];
        if (tile.flags & (TileCrop | TileClamp)) continue;
        if (tile.frame.size.width + tile.sx * dw < -0.01 || tile.frame.size.height + tile.sy * dh < -0.01) return NO;
    }
    return YES;
}

static void requestPreview(void) {
    dropReady();
    if (!requestSnapshot) return;
    unsigned request = pendingRequest = ++serial;
    pendingAt = now();
    requestSnapshot(request);
}

static BOOL snapshotComing(NSTimeInterval within) { return pendingRequest && now() - pendingAt < within; }

static NSVisualEffectView *effectViewIn(NSView *view) {
    for (NSView *child in view.subviews)
        if ([child isKindOfClass:NSVisualEffectView.class]) return (NSVisualEffectView *)child;
    return nil;
}

/** 记下主窗口红绿灯的位置（离左上角）和标题栏高度：Electron 按 trafficLightPosition 挪过它们。全屏时看不到，用进全屏前记的。 */
static void saveButtons(NSWindow *window) {
    if (window.styleMask & NSWindowStyleMaskFullScreen) return;
    CGFloat height = NSHeight(window.frame);
    NSWindowButton types[] = {NSWindowCloseButton, NSWindowMiniaturizeButton, NSWindowZoomButton};
    for (int index = 0; index < 3; ++index) {
        NSButton *button = [window standardWindowButton:types[index]];
        if (!button) continue;
        NSRect rect = [button convertRect:button.bounds toView:nil];
        buttonRects[index] = NSMakeRect(NSMinX(rect), height - NSMaxY(rect), NSWidth(rect), NSHeight(rect));
        titlebarHeight = NSHeight(button.superview.superview.frame);
    }
}

/** 过渡窗口的红绿灯摆到主窗口那样；进全屏时随进度淡出，出全屏时淡入。 */
static void placeButtons(NSWindow *window) {
    NSButton *close = [window standardWindowButton:NSWindowCloseButton];
    NSView *container = close.superview.superview;
    if (!close || !container || titlebarHeight <= 0) return;
    NSSize size = window.frame.size;
    container.frame = NSMakeRect(0, size.height - titlebarHeight, size.width, titlebarHeight);
    NSWindowButton types[] = {NSWindowCloseButton, NSWindowMiniaturizeButton, NSWindowZoomButton};
    for (int index = 0; index < 3; ++index) {
        NSButton *button = [window standardWindowButton:types[index]];
        NSRect rect = buttonRects[index];
        if (button && rect.size.width > 0)
            button.frame = [button.superview convertRect:NSMakeRect(NSMinX(rect), size.height - NSMinY(rect) - NSHeight(rect), NSWidth(rect), NSHeight(rect)) fromView:nil];
    }
    if (transitionMode < 0) return;
    BOOL wide = fabs(transitionTo.width - transitionFrom.width) > 0.5;
    CGFloat span = wide ? transitionTo.width - transitionFrom.width : transitionTo.height - transitionFrom.height;
    CGFloat moved = wide ? size.width - transitionFrom.width : size.height - transitionFrom.height;
    CGFloat progress = fabs(span) > 0.5 ? MIN(1, MAX(0, moved / span)) : 1;
    container.alphaValue = transitionMode == 1 ? 1 - progress : progress;
}

@interface PlumeTransitionDelegate : NSObject <NSWindowDelegate>
@end
@implementation PlumeTransitionDelegate
- (void)windowDidResize:(NSNotification *)notification { placeButtons(notification.object); }
@end
static PlumeTransitionDelegate *overlayDelegate;

static PlumeTransitionWindow *makeOverlay(NSWindow *window) {
    NSUInteger style = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable | NSWindowStyleMaskFullSizeContentView;
    PlumeTransitionWindow *cover = [[PlumeTransitionWindow alloc] initWithContentRect:NSMakeRect(0, 0, 100, 100) styleMask:style backing:NSBackingStoreBuffered defer:NO];
    cover.releasedWhenClosed = NO;
    cover.titlebarAppearsTransparent = YES;
    cover.titleVisibility = NSWindowTitleHidden;
    cover.animationBehavior = NSWindowAnimationBehaviorNone;
    cover.collectionBehavior = NSWindowCollectionBehaviorFullScreenAuxiliary | NSWindowCollectionBehaviorIgnoresCycle | NSWindowCollectionBehaviorTransient;
    cover.ignoresMouseEvents = YES;
    cover.hasShadow = window.hasShadow;
    cover.appearance = window.effectiveAppearance;
    cover.level = window.level;
    cover.minSize = NSMakeSize(1, 1);
    cover.maxSize = NSMakeSize(CGFLOAT_MAX, CGFLOAT_MAX);
    [cover setAccessibilityElement:NO];
    [cover setFrame:window.frame display:NO];
    NSView *root = cover.contentView;
    NSVisualEffectView *source = effectViewIn(window.contentView);
    if (source) {
        cover.opaque = NO;
        cover.backgroundColor = NSColor.clearColor;
        NSVisualEffectView *effect = [[NSVisualEffectView alloc] initWithFrame:root.bounds];
        effect.material = source.material;
        effect.blendingMode = source.blendingMode;
        effect.state = source.state;
        effect.emphasized = source.emphasized;
        effect.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        [root addSubview:effect];
    } else {
        cover.opaque = window.opaque;
        cover.backgroundColor = window.backgroundColor;
    }
    overlayDelegate = overlayDelegate ?: [PlumeTransitionDelegate new];
    cover.delegate = overlayDelegate;
    placeButtons(cover);
    return cover;
}

/*
 * 进出全屏时系统要先拿到参与动画的窗口，才把它们一起搬到全屏的桌面（出全屏时搬回来）；过渡窗口不在其中就留在原来的桌面上，
 * 跟着桌面滑走。所以全屏时过渡窗口在 customWindows… 里先建好（截图可能还在路上，先空着），动画开始时再放截图、显示出来。
 */
static PlumeTransitionWindow *fullscreenOverlay;

static void dropFullscreenOverlay(void) {
    [fullscreenOverlay orderOut:nil];
    fullscreenOverlay = nil;
}

/** 盖上过渡窗口、藏起主窗口。截图用不上（过期、尺寸变过、空白不够缩）时什么都不做。 */
static BOOL beginTransition(NSWindow *window, NSSize target, int mode) {
    PlumeTransitionWindow *prepared = fullscreenOverlay;
    fullscreenOverlay = nil;
    if (!readyFor(target)) {
        dropReady();
        [prepared orderOut:nil];
        return NO;
    }
    transitionMode = mode;
    transitionFrom = window.frame.size;
    transitionTo = target;
    overlay = prepared ?: makeOverlay(window);
    [overlay setFrame:window.frame display:NO];
    NSView *root = overlay.contentView;
    PlumeTransitionView *picture = [[PlumeTransitionView alloc] initWithFrame:root.bounds pixels:readyImage tiles:readyTiles reach:target];
    picture.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [root addSubview:picture];
    placeButtons(overlay);
    dropReady();
    overlay.alphaValue = 1;
    [overlay orderWindow:NSWindowAbove relativeTo:window.windowNumber];
    window.alphaValue = 0;
    transitionRequest = ++serial;
    animationDone = pageSettled = pageMatched = NO;
    return YES;
}

static void endTransition(BOOL matched) {
    NSWindow *window = watchedWindow;
    PlumeTransitionWindow *closing = overlay;
    overlay = nil;
    transitionRequest = 0;
    window.alphaValue = 1;
    if (!closing) return;
    if (matched) {
        // 主窗口先亮出来（被过渡窗口盖着），合成一帧后再撤，中间不会空一下。
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 34 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ [closing orderOut:nil]; });
        return;
    }
    [NSAnimationContext
        runAnimationGroup:^(NSAnimationContext *context) {
            context.duration = 0.15;
            closing.animator.alphaValue = 0;
        }
        completionHandler:^{ [closing orderOut:nil]; }];
}

static void trySwap(void) {
    if (!overlay || !animationDone) return;
    if (pageSettled) {
        endTransition(pageMatched);
        return;
    }
    unsigned request = transitionRequest;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 1200 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
        if (request == transitionRequest) endTransition(NO);
    });
}

/** 页面经 koffi 调进来：换窗口放到下一轮，不在这次调用里改窗口（同 plume_prepare_zoom 的说明）。 */
void plume_page_settled(unsigned request, bool matched) {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!request || request != transitionRequest) return;
        pageSettled = YES;
        pageMatched = matched;
        trySwap();
    });
}

static void animateOverlay(NSRect target, NSTimeInterval duration) {
    unsigned request = transitionRequest;
    [NSAnimationContext
        runAnimationGroup:^(NSAnimationContext *context) {
            context.duration = duration;
            context.timingFunction = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseInEaseOut];
            [[overlay animator] setFrame:target display:YES];
        }
        completionHandler:^{
            if (request != transitionRequest) return;
            animationDone = YES;
            trySwap();
        }];
}

static void askPage(NSWindow *window) {
    NSSize size = window.contentView.bounds.size;
    if (settlePage) settlePage(transitionRequest, size.width, size.height, transitionMode);
}

// ── 放大、还原 ─────────────────────────────────────────────────────

static BOOL callBaseZoom(id delegate, SEL selector, NSWindow *window, NSRect frame) {
    return baseShouldZoom ? ((BOOL (*)(id, SEL, NSWindow *, NSRect))baseShouldZoom)(delegate, selector, window, frame) : YES;
}

/** 照常再缩放一次：经过原来的代理（Electron 在这里发 maximize、unmaximize），`instant` 时不播动画，主窗口藏着一步到位。 */
static void zoomForReal(NSWindow *window, BOOL instant) {
    passZoom = YES;
    instantResize = instant;
    [window zoom:nil];
    passZoom = NO;
    instantResize = NO;
}

static void startZoom(NSWindow *window, NSRect frame) {
    NSTimeInterval duration = [window animationResizeTime:frame];
    if (!beginTransition(window, [window contentRectForFrameRect:frame].size, -1)) {
        zoomForReal(window, NO);
        return;
    }
    animateOverlay(frame, duration);
    unsigned request = transitionRequest;
    // 不在 windowShouldZoom 里面套着再缩放一次：等这一轮返回了再做。
    dispatch_async(dispatch_get_main_queue(), ^{
        if (request != transitionRequest) return;
        zoomForReal(window, YES);
        askPage(window);
    });
}

static void resumeZoom(void) {
    NSWindow *window = watchedWindow;
    if (!zoomWaiting || !window) return;
    zoomWaiting = NO;
    if (readyFor([window contentRectForFrameRect:waitingZoom].size)) startZoom(window, waitingZoom);
    else zoomForReal(window, NO);
}

static BOOL shouldZoom(id delegate, SEL selector, NSWindow *window, NSRect frame) {
    if (passZoom || window != watchedWindow || reduceMotion() || (window.styleMask & NSWindowStyleMaskFullScreen))
        return callBaseZoom(delegate, selector, window, frame);
    if (overlay || zoomWaiting) return NO;
    if (readyFor([window contentRectForFrameRect:frame].size)) {
        startZoom(window, frame);
        return NO;
    }
    // 双击太快、截图还在路上：最多再等一小会儿，等不到就照常缩放。
    if (snapshotComing(0.25)) {
        zoomWaiting = YES;
        waitingZoom = frame;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 80 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ resumeZoom(); });
        return NO;
    }
    dropReady();
    return callBaseZoom(delegate, selector, window, frame);
}

static NSTimeInterval resizeTime(id window, SEL selector, NSRect frame) {
    if (instantResize && window == watchedWindow) return 0;
    return ((NSTimeInterval (*)(id, SEL, NSRect))baseResizeTime)(window, selector, frame);
}

// ── 进出全屏 ───────────────────────────────────────────────────────

static NSNumber *displayOf(NSScreen *screen) { return screen.deviceDescription[@"NSScreenNumber"]; }

/** 全屏后窗口实际的位置：带刘海的屏幕上，系统把菜单栏那一条留黑，窗口从它下面开始。 */
static NSRect fullscreenTarget(NSScreen *screen) {
    NSRect frame = screen.frame;
    if (@available(macOS 12.0, *)) frame.size.height -= screen.safeAreaInsets.top;
    return frame;
}

static NSArray *preparedWindows(NSWindow *window) {
    dropFullscreenOverlay();
    fullscreenOverlay = makeOverlay(window);
    // 先放在主窗口下面、完全透明：参与系统的搬动，但开始前看不见。
    fullscreenOverlay.alphaValue = 0;
    [fullscreenOverlay orderWindow:NSWindowBelow relativeTo:window.windowNumber];
    return @[window, fullscreenOverlay];
}

static NSArray *enterWindows(id delegate, SEL selector, NSWindow *window, NSScreen *screen) {
    originalDisplay = nil;
    if (window != watchedWindow || ![displayOf(screen) isEqual:displayOf(window.screen)] || reduceMotion()) return nil;
    // 没有截图也不在路上（键盘、菜单切全屏）：交给系统的过渡。
    if (!readyFor([window contentRectForFrameRect:fullscreenTarget(screen)].size) && !snapshotComing(0.3)) return nil;
    originalDisplay = displayOf(screen);
    windowedFrame = window.frame;
    saveButtons(window);
    return preparedWindows(window);
}

static NSArray *exitWindows(id delegate, SEL selector, NSWindow *window) {
    // 全屏期间换了分辨率、挪了显示器，原来的窗框可能已经不在屏上：这时交给系统摆。
    if (window != watchedWindow || ![originalDisplay isEqual:displayOf(window.screen)] || !NSContainsRect(window.screen.frame, windowedFrame) || reduceMotion())
        return nil;
    if (!readyFor([window contentRectForFrameRect:windowedFrame].size) && !snapshotComing(0.3)) return nil;
    return preparedWindows(window);
}

static void runFullscreen(NSWindow *window, NSRect target, NSTimeInterval duration, BOOL entering) {
    NSTimeInterval deadline = now() + duration;
    void (^start)(void) = ^{
        startFullscreen = nil;
        pendingRequest = 0;
        BOOL covered = beginTransition(window, [window contentRectForFrameRect:target].size, entering ? 1 : 0);
        // 全屏的样式进入时一开始就带上、退出时一开始就去掉（只能在过渡里改，过渡外加上会抛异常）。
        if (entering) window.styleMask |= NSWindowStyleMaskFullScreen;
        else window.styleMask &= ~NSWindowStyleMaskFullScreen;
        // 系统按给的时长收尾，晚开始的那一截从时长里扣掉，不拖过它。
        NSTimeInterval left = MAX(0, deadline - now());
        if (covered) {
            animateOverlay(target, left);
            // 桌面刚开始切换的那几帧系统会抓主窗口的画面（不管它透不透明）：主窗口这时已经跳到终点的话，就会闪出一帧终点排版。
            // 等过渡窗口接上几帧再跳。
            unsigned request = transitionRequest;
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 80 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
                if (request != transitionRequest) return;
                [window setFrame:target display:YES];
                askPage(window);
            });
            return;
        }
        if (entering) [window setFrame:windowedFrame display:NO];
        [NSAnimationContext
            runAnimationGroup:^(NSAnimationContext *context) {
                context.duration = left;
                context.timingFunction = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseInEaseOut];
                [[window animator] setFrame:target display:YES];
            }
            completionHandler:nil];
    };
    if (readyImage || !pendingRequest) {
        start();
        return;
    }
    startFullscreen = start;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(MIN(0.1, duration / 3) * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        if (startFullscreen == start) start();
    });
}

static void startEnter(id delegate, SEL selector, NSWindow *window, NSScreen *screen, NSTimeInterval duration) {
    fullscreenFrame = fullscreenTarget(screen);
    runFullscreen(window, fullscreenFrame, duration, YES);
}

static void startExit(id delegate, SEL selector, NSWindow *window, NSTimeInterval duration) {
    runFullscreen(window, windowedFrame, duration, NO);
}

/*
 * 系统没切成时撤掉过渡、把窗框放回切之前的样子，再交给原来的代理。全屏样式由 AppKit 自己复原：过渡之外给窗口加
 * NSWindowStyleMaskFullScreen 会抛异常，退出失败时不能自己补回去。
 */
static void failEnter(id delegate, SEL selector, NSWindow *window) {
    if (window == watchedWindow && originalDisplay) {
        startFullscreen = nil;
        dropFullscreenOverlay();
        endTransition(YES);
        [window setFrame:windowedFrame display:YES];
    }
    if (baseFailEnter) ((void (*)(id, SEL, NSWindow *))baseFailEnter)(delegate, selector, window);
}

static void failExit(id delegate, SEL selector, NSWindow *window) {
    if (window == watchedWindow && originalDisplay) {
        startFullscreen = nil;
        dropFullscreenOverlay();
        endTransition(YES);
        [window setFrame:fullscreenFrame display:YES];
    }
    if (baseFailExit) ((void (*)(id, SEL, NSWindow *))baseFailExit)(delegate, selector, window);
}

// ── 接到主窗口上 ───────────────────────────────────────────────────

static IMP baseImplementation(Class base, SEL selector) { return [base instancesRespondToSelector:selector] ? class_getMethodImplementation(base, selector) : NULL; }

/** 给 Electron 的窗口代理换成多了这几个方法的子类（只换这一个对象的类），撤销时换回去。 */
static void installDelegate(NSWindow *window) {
    id delegate = window.delegate;
    if (!delegate) return;
    SEL selectors[] = {@selector(customWindowsToEnterFullScreenForWindow:onScreen:),
                       @selector(customWindowsToExitFullScreenForWindow:),
                       @selector(window:startCustomAnimationToEnterFullScreenOnScreen:withDuration:),
                       @selector(window:startCustomAnimationToExitFullScreenWithDuration:),
                       @selector(windowDidFailToEnterFullScreen:),
                       @selector(windowDidFailToExitFullScreen:),
                       @selector(windowShouldZoom:toFrame:)};
    IMP implementations[] = {(IMP)enterWindows, (IMP)exitWindows, (IMP)startEnter, (IMP)startExit, (IMP)failEnter, (IMP)failExit, (IMP)shouldZoom};
    const int count = sizeof selectors / sizeof *selectors;
    Class base = object_getClass(delegate);
    if (!delegateClass) {
        // 原来的代理自己做全屏动画就不接手。失败回调、windowShouldZoom 它有的话，补上的方法做完自己的再转给它。
        if ([delegate respondsToSelector:@selector(customWindowsToEnterFullScreenForWindow:)]) return;
        for (int index = 0; index < 4; ++index)
            if ([delegate respondsToSelector:selectors[index]]) return;
        baseFailEnter = baseImplementation(base, selectors[4]);
        baseFailExit = baseImplementation(base, selectors[5]);
        baseShouldZoom = baseImplementation(base, selectors[6]);
        Class subclass = objc_allocateClassPair(base, "PlumeMainWindowFullscreenDelegate", 0);
        if (!subclass) return;
        for (int index = 0; index < count; ++index) {
            const char *types = protocol_getMethodDescription(@protocol(NSWindowDelegate), selectors[index], NO, YES).types;
            if (!types || !class_addMethod(subclass, selectors[index], implementations[index], types)) {
                objc_disposeClassPair(subclass);
                return;
            }
        }
        objc_registerClassPair(subclass);
        delegateClass = subclass;
    }
    if (class_getSuperclass(delegateClass) != base) return;
    window.delegate = nil;
    object_setClass(delegate, delegateClass);
    window.delegate = delegate;
    installedDelegate = delegate;
}

/** 缩放动画的时长由窗口的 animationResizeTime: 给：在窗口类上补一个，只有藏着一步到位的那次返回 0，其余照旧。 */
static void installResizeTime(NSWindow *window) {
    if (baseResizeTime) return;
    SEL selector = @selector(animationResizeTime:);
    Method method = class_getInstanceMethod(window.class, selector);
    if (!method) return;
    IMP inherited = method_getImplementation(method);
    if (class_addMethod(window.class, selector, (IMP)resizeTime, method_getTypeEncoding(method))) baseResizeTime = inherited;
}

/** 按在绿色按钮上：它可能在主窗口里，也可能在全屏时顶上那条浮出来的标题栏窗口里。 */
static BOOL onZoomButton(NSWindow *window, NSEvent *event) {
    NSButton *zoom = [window standardWindowButton:NSWindowZoomButton];
    return zoom && event.window == zoom.window && NSPointInRect([zoom convertPoint:event.locationInWindow fromView:nil], zoom.bounds);
}

/** 顶行空白处：页面在这里不接点击（拖动区），落到窗口本身。 */
static BOOL onTitleBar(NSWindow *window, NSEvent *event, double height) {
    if (event.window != window) return NO;
    NSView *root = window.contentView;
    NSPoint point = [root convertPoint:event.locationInWindow fromView:nil];
    CGFloat fromTop = root.isFlipped ? point.y : NSHeight(root.bounds) - point.y;
    return fromTop >= 0 && fromTop <= height && ![root hitTest:point];
}

void plume_prepare_zoom(unsigned request, void *nsImage, double *values, unsigned count) {
    if (!request || request != pendingRequest) return;
    pendingRequest = 0;
    dropReady();
    CGImageRef pixels = nsImage && values && count ? [(__bridge NSImage *)nsImage CGImageForProposedRect:NULL context:nil hints:nil] : NULL;
    if (pixels) {
        NSMutableData *tiles = [NSMutableData dataWithLength:count * sizeof(PlumeTile)];
        PlumeTile *list = tiles.mutableBytes;
        for (unsigned index = 0; index < count; ++index) {
            double *v = values + index * TileFields;
            list[index] = (PlumeTile){CGRectMake(v[0], v[1], v[2], v[3]), CGRectMake(v[4], v[5], v[6], v[7]), v[8], v[9], v[10], v[11], (int)v[12]};
        }
        readyImage = CGImageRetain(pixels);
        readyTiles = tiles;
        readySize = watchedWindow.contentView.bounds.size;
        readyAt = now();
    }
    // 这里是页面经 koffi 调进来的：当场开动画会改窗框，Electron 同步发 JS 事件，在 koffi 调用里重入 Node 会让 V8 崩掉。
    if (zoomWaiting) dispatch_async(dispatch_get_main_queue(), ^{ resumeZoom(); });
    void (^start)(void) = startFullscreen;
    if (start)
        dispatch_async(dispatch_get_main_queue(), ^{
            if (startFullscreen == start) start();
        });
}

void plume_watch_zoom(void *handle, double height, void (*snapshot)(unsigned), void (*settle)(unsigned, double, double, int)) {
    NSWindow *window = ((__bridge NSView *)handle).window;
    watchedWindow = window;
    requestSnapshot = snapshot;
    settlePage = settle;
    saveButtons(window);
    installDelegate(window);
    installResizeTime(window);
    clickMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDown handler:^NSEvent *(NSEvent *event) {
        if (reduceMotion() || event.clickCount != 1 || overlay) return event;
        BOOL fullscreen = (window.styleMask & NSWindowStyleMaskFullScreen) != 0;
        if (onZoomButton(window, event) || (!fullscreen && onTitleBar(window, event, height))) requestPreview();
        return event;
    }];
}

void plume_unwatch_zoom(void) {
    if (clickMonitor) [NSEvent removeMonitor:clickMonitor];
    clickMonitor = nil;
    dropFullscreenOverlay();
    endTransition(YES);
    dropReady();
    pendingRequest = 0;
    zoomWaiting = NO;
    startFullscreen = nil;
    requestSnapshot = NULL;
    settlePage = NULL;
    id delegate = installedDelegate;
    if (delegate && object_getClass(delegate) == delegateClass) {
        NSWindow *attached = watchedWindow.delegate == delegate ? watchedWindow : nil;
        attached.delegate = nil;
        object_setClass(delegate, class_getSuperclass(delegateClass));
        attached.delegate = delegate;
    }
    installedDelegate = nil;
    watchedWindow = nil;
    originalDisplay = nil;
}
