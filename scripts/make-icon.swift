import AppKit

MainActor.assumeIsolated {
    let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "build/icon"
    let canvas: CGFloat = 1024

    // Source of truth: the neon green ring-arrow mark.
    let markURL = URL(fileURLWithPath: "Resources/BrandMark.png")
    guard let mark = NSImage(contentsOf: markURL) else {
        FileHandle.standardError.write(Data("missing Resources/BrandMark.png\n".utf8))
        exit(1)
    }

    let image = NSImage(size: NSSize(width: canvas, height: canvas))
    image.lockFocus()
    let rect = NSRect(x: 0, y: 0, width: canvas, height: canvas)

    // near-black squircle (#0A0C0B)
    let inset = canvas * 0.018
    let shape = NSBezierPath(roundedRect: rect.insetBy(dx: inset, dy: inset),
                             xRadius: canvas * 0.228, yRadius: canvas * 0.228)
    shape.addClip()
    NSColor(srgbRed: 0.039, green: 0.047, blue: 0.043, alpha: 1).setFill()
    shape.fill()

    // faint grain so the dark face isn't flat
    for _ in 0..<16000 {
        let x = CGFloat.random(in: rect.minX...rect.maxX)
        let y = CGFloat.random(in: rect.minY...rect.maxY)
        let alpha = CGFloat.random(in: 0...0.035)
        NSColor.white.withAlphaComponent(alpha).setFill()
        NSRect(x: x, y: y, width: 2.2, height: 2.2).fill()
    }

    // center the ring-arrow; the mark's own padding lands it at ~62% of the canvas
    let markSize = canvas * 0.82
    let markRect = NSRect(x: (canvas - markSize) / 2, y: (canvas - markSize) / 2,
                          width: markSize, height: markSize)
    mark.draw(in: markRect)

    // crisp inner edge
    NSColor.white.withAlphaComponent(0.16).setStroke()
    let border = NSBezierPath(roundedRect: rect.insetBy(dx: canvas * 0.038, dy: canvas * 0.038),
                              xRadius: canvas * 0.205, yRadius: canvas * 0.205)
    border.lineWidth = canvas * 0.009
    border.stroke()

    image.unlockFocus()

    guard let tiff = image.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff),
          let png = rep.representation(using: .png, properties: [:]) else {
        FileHandle.standardError.write(Data("icon render failed\n".utf8))
        exit(1)
    }
    try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
    let url = URL(fileURLWithPath: outDir).appendingPathComponent("AppIcon-1024.png")
    try? png.write(to: url)
    print("wrote \(url.path)")
}
