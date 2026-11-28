import SwiftUI
import VisionKit

/// Reads an access key from a QR code with the camera.
struct AccessKeyScanner: UIViewControllerRepresentable {
	let onText: (String) -> Void

	static var isAvailable: Bool { DataScannerViewController.isSupported && DataScannerViewController.isAvailable }

	func makeCoordinator() -> Coordinator { Coordinator(onText: onText) }

	func makeUIViewController(context: Context) -> DataScannerViewController {
		let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced, isHighlightingEnabled: true)
		scanner.delegate = context.coordinator
		try? scanner.startScanning()
		return scanner
	}

	func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {}

	static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
		scanner.stopScanning()
	}

	final class Coordinator: NSObject, DataScannerViewControllerDelegate {
		let onText: (String) -> Void

		init(onText: @escaping (String) -> Void) { self.onText = onText }

		func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
			for case .barcode(let code) in addedItems {
				if let text = code.payloadStringValue { onText(text) }
			}
		}
	}
}
