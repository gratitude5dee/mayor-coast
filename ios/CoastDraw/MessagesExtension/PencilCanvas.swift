import PencilKit
import SwiftUI

@MainActor
final class PencilCanvasController: ObservableObject {
    weak var canvas: PKCanvasView?
    var backgroundImage: UIImage?

    func undo() { canvas?.undoManager?.undo() }
    func redo() { canvas?.undoManager?.redo() }
    func clear() { canvas?.drawing = PKDrawing() }

    func png() -> Data? {
        guard let canvas, backgroundImage != nil || !canvas.drawing.strokes.isEmpty else { return nil }
        let source = canvas.bounds
        guard source.width > 0, source.height > 0 else { return nil }
        let target = CGSize(width: 1_024, height: 1_024)
        let image = canvas.drawing.image(from: source, scale: 1_024 / max(source.width, source.height))
        let renderer = UIGraphicsImageRenderer(size: target)
        return renderer.pngData { context in
            UIColor.white.setFill()
            context.fill(CGRect(origin: .zero, size: target))
            if let backgroundImage {
                let scale = min(target.width / backgroundImage.size.width, target.height / backgroundImage.size.height)
                let size = CGSize(width: backgroundImage.size.width * scale, height: backgroundImage.size.height * scale)
                backgroundImage.draw(in: CGRect(x: (target.width - size.width) / 2, y: (target.height - size.height) / 2, width: size.width, height: size.height))
            }
            let scale = min(target.width / image.size.width, target.height / image.size.height)
            let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
            image.draw(in: CGRect(x: (target.width - size.width) / 2, y: (target.height - size.height) / 2, width: size.width, height: size.height))
        }
    }
}

struct PencilCanvas: UIViewRepresentable {
    @ObservedObject var controller: PencilCanvasController
    let color: UIColor
    let width: CGFloat
    let erasing: Bool

    func makeUIView(context: Context) -> PKCanvasView {
        let canvas = PKCanvasView()
        canvas.backgroundColor = .clear
        canvas.isOpaque = false
        canvas.drawingPolicy = .anyInput
        canvas.minimumZoomScale = 1
        canvas.maximumZoomScale = 1
        canvas.tool = tool
        controller.canvas = canvas
        return canvas
    }

    func updateUIView(_ canvas: PKCanvasView, context: Context) {
        canvas.tool = tool
        controller.canvas = canvas
    }

    private var tool: PKTool {
        erasing ? PKEraserTool(.vector) : PKInkingTool(.pen, color: color, width: width)
    }
}
