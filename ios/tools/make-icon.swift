// Draws the app icon: a white envelope on Mailflare's blue, 1024 px, without transparency.
//   DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift ios/tools/make-icon.swift <output.png>
import AppKit

import ImageIO
import UniformTypeIdentifiers

let size = 1024
// No alpha channel at all: App Store Connect refuses an icon that has one.
let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)

func color(_ hex: UInt32) -> NSColor {
	NSColor(deviceRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
}

// Background: the accent blue of the web app, lighter towards the top.
NSGradient(starting: color(0x0842A0), ending: color(0x2F7BF5))!.draw(in: NSRect(x: 0, y: 0, width: size, height: size), angle: 90)

// The envelope's body.
let body = NSRect(x: 192, y: 292, width: 640, height: 440)
let envelope = NSBezierPath(roundedRect: body, xRadius: 56, yRadius: 56)
let shadow = NSShadow()
shadow.shadowColor = NSColor(deviceWhite: 0, alpha: 0.22)
shadow.shadowBlurRadius = 36
shadow.shadowOffset = NSSize(width: 0, height: -14)
NSGraphicsContext.saveGraphicsState()
shadow.set()
NSColor.white.setFill()
envelope.fill()
NSGraphicsContext.restoreGraphicsState()

// The flap: two lines meeting below the middle, clipped to the body.
NSGraphicsContext.saveGraphicsState()
envelope.addClip()
let flap = NSBezierPath()
flap.move(to: NSPoint(x: body.minX + 6, y: body.maxY - 34))
flap.line(to: NSPoint(x: body.midX, y: body.midY - 26))
flap.line(to: NSPoint(x: body.maxX - 6, y: body.maxY - 34))
flap.lineWidth = 34
flap.lineJoinStyle = .round
flap.lineCapStyle = .round
color(0x0B57D0).setStroke()
flap.stroke()
NSGraphicsContext.restoreGraphicsState()

guard CommandLine.arguments.count == 2 else { fatalError("Pass the output path.") }
let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(destination, context.makeImage()!, nil)
guard CGImageDestinationFinalize(destination) else { fatalError("Could not write the icon.") }
