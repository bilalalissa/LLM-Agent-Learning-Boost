import AppKit
import Foundation

let output = CommandLine.arguments.dropFirst().first ?? "AppIcon.png"
let size = NSSize(width: 1024, height: 1024)
let image = NSImage(size: size)

func color(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat, _ alpha: CGFloat = 1) -> NSColor {
    NSColor(calibratedRed: red, green: green, blue: blue, alpha: alpha)
}

image.lockFocus()

let rect = NSRect(origin: .zero, size: size)
NSColor.clear.setFill()
rect.fill()

let iconRect = rect.insetBy(dx: 76, dy: 76)
let outer = NSBezierPath(roundedRect: iconRect, xRadius: 218, yRadius: 218)
NSGradient(colors: [
    color(0.07, 0.34, 0.85),
    color(0.04, 0.68, 0.60),
    color(0.95, 0.78, 0.30)
])?.draw(in: outer, angle: 135)

NSGraphicsContext.current?.saveGraphicsState()
outer.addClip()
let wave = NSBezierPath()
wave.move(to: NSPoint(x: 174, y: 698))
wave.curve(to: NSPoint(x: 489, y: 457), controlPoint1: NSPoint(x: 321, y: 666), controlPoint2: NSPoint(x: 421, y: 585))
wave.curve(to: NSPoint(x: 779, y: 251), controlPoint1: NSPoint(x: 552, y: 339), controlPoint2: NSPoint(x: 645, y: 269))
wave.curve(to: NSPoint(x: 874, y: 246), controlPoint1: NSPoint(x: 817, y: 246), controlPoint2: NSPoint(x: 849, y: 244))
wave.line(to: NSPoint(x: 874, y: 948))
wave.line(to: NSPoint(x: 174, y: 948))
wave.close()
NSColor.white.withAlphaComponent(0.16).setFill()
wave.fill()
NSGraphicsContext.current?.restoreGraphicsState()

let shadow = NSShadow()
shadow.shadowColor = color(0.04, 0.09, 0.19, 0.25)
shadow.shadowBlurRadius = 24
shadow.shadowOffset = NSSize(width: 0, height: -18)
shadow.set()

let card = NSBezierPath(roundedRect: NSRect(x: 254, y: 190, width: 516, height: 644), xRadius: 72, yRadius: 72)
color(0.98, 0.99, 1.0).setFill()
card.fill()

NSShadow().set()
let fold = NSBezierPath()
fold.move(to: NSPoint(x: 610, y: 834))
fold.line(to: NSPoint(x: 770, y: 674))
fold.line(to: NSPoint(x: 653, y: 674))
fold.curve(to: NSPoint(x: 610, y: 717), controlPoint1: NSPoint(x: 629, y: 674), controlPoint2: NSPoint(x: 610, y: 693))
fold.close()
color(0.87, 0.96, 0.94).setFill()
fold.fill()

let lineColor = color(0.07, 0.20, 0.36)
for (y, width, alpha) in [(668.0, 302.0, 1.0), (568.0, 232.0, 0.82), (468.0, 282.0, 0.82)] {
    let line = NSBezierPath()
    line.lineWidth = y == 668.0 ? 34 : 30
    line.lineCapStyle = .round
    line.move(to: NSPoint(x: 360, y: y))
    line.line(to: NSPoint(x: 360 + width, y: y))
    lineColor.withAlphaComponent(alpha).setStroke()
    line.stroke()
}

let recallPath = NSBezierPath()
recallPath.lineWidth = 18
recallPath.lineCapStyle = .round
recallPath.lineJoinStyle = .round
recallPath.move(to: NSPoint(x: 364, y: 326))
recallPath.curve(to: NSPoint(x: 566, y: 362), controlPoint1: NSPoint(x: 422, y: 410), controlPoint2: NSPoint(x: 489, y: 422))
recallPath.curve(to: NSPoint(x: 719, y: 383), controlPoint1: NSPoint(x: 620, y: 320), controlPoint2: NSPoint(x: 671, y: 327))
color(0.04, 0.44, 0.39).setStroke()
recallPath.stroke()

let arrow = NSBezierPath()
arrow.lineWidth = 18
arrow.lineCapStyle = .round
arrow.lineJoinStyle = .round
arrow.move(to: NSPoint(x: 693, y: 380))
arrow.line(to: NSPoint(x: 733, y: 380))
arrow.line(to: NSPoint(x: 733, y: 340))
color(0.04, 0.44, 0.39).setStroke()
arrow.stroke()

for (point, dotColor) in [
    (NSPoint(x: 365, y: 326), color(0.95, 0.78, 0.30)),
    (NSPoint(x: 512, y: 386), color(0.07, 0.75, 0.65)),
    (NSPoint(x: 720, y: 382), color(0.07, 0.34, 0.85))
] {
    let dot = NSBezierPath(ovalIn: NSRect(x: point.x - 34, y: point.y - 34, width: 68, height: 68))
    dotColor.setFill()
    dot.fill()
}

image.unlockFocus()

guard let tiff = image.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let png = bitmap.representation(using: .png, properties: [:]) else {
    fatalError("Could not render icon PNG")
}

try png.write(to: URL(fileURLWithPath: output))
