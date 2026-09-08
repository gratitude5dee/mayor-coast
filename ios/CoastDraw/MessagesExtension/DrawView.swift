import SwiftUI
import UIKit
import PhotosUI

struct DrawView: View {
    @ObservedObject var model: DrawSessionModel
    @StateObject private var canvas = PencilCanvasController()
    @State private var prompt = ""
    @State private var width: CGFloat = 12
    @State private var color = UIColor(red: 0.09, green: 0.14, blue: 0.11, alpha: 1)
    @State private var erasing = false
    @State private var importedPhoto: PhotosPickerItem?

    private let amber = Color(red: 0.96, green: 0.71, blue: 0.27)
    private let green = Color(red: 0.09, green: 0.14, blue: 0.11)
    private let cream = Color(red: 0.97, green: 0.95, blue: 0.88)

    var body: some View {
        VStack(spacing: 10) {
            HStack {
                VStack(alignment: .leading, spacing: 1) {
                    Text("COAST DRAW").font(.caption2.bold()).tracking(1.4).foregroundStyle(amber)
                    Text(model.phase.label).font(.caption).foregroundStyle(cream.opacity(0.78))
                }
                Spacer()
                if model.phase.isBusy { ProgressView().tint(amber) }
            }

            ZStack(alignment: .bottomTrailing) {
                Color.white
                if let image = model.resultImage ?? canvas.backgroundImage {
                    Image(uiImage: image).resizable().scaledToFit().allowsHitTesting(false)
                }
                PencilCanvas(controller: canvas, color: color, width: width, erasing: erasing)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                    .aspectRatio(1, contentMode: .fit)
            }

            HStack(spacing: 8) {
                ForEach([UIColor.black, .systemOrange, .systemRed, .systemBlue], id: \.self) { item in
                    Button { color = item; erasing = false } label: {
                        Circle().fill(Color(uiColor: item)).frame(width: 24, height: 24).overlay(Circle().stroke(cream, lineWidth: 1))
                    }
                }
                Button { erasing.toggle() } label: { Image(systemName: "eraser.fill") }.tint(erasing ? amber : cream)
                Button { canvas.undo() } label: { Image(systemName: "arrow.uturn.backward") }.tint(cream)
                Button { canvas.redo() } label: { Image(systemName: "arrow.uturn.forward") }.tint(cream)
                Button { canvas.clear() } label: { Image(systemName: "trash") }.tint(cream)
                PhotosPicker(selection: $importedPhoto, matching: .images) {
                    Image(systemName: "photo")
                }.tint(cream)
            }

            HStack(spacing: 8) {
                TextField("Turn this sketch into…", text: $prompt)
                    .textFieldStyle(.roundedBorder)
                    .submitLabel(.done)
                Button("Generate") {
                    let data = canvas.png()
                    Task { await model.generate(prompt: prompt, imageData: data) }
                }
                .buttonStyle(.borderedProminent)
                .tint(amber)
                .foregroundStyle(green)
                .disabled(model.phase.isBusy)
            }
        }
        .padding(12)
        .background(green.ignoresSafeArea())
        .onReceive(model.$resultImage) { image in
            if let image { canvas.backgroundImage = image }
        }
        .onChange(of: importedPhoto) { _, item in
            guard let item else { return }
            Task {
                guard let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else { return }
                await MainActor.run { canvas.backgroundImage = image }
            }
        }
    }
}
