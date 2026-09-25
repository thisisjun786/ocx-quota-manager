#!/usr/bin/env bash
# Mac-only reproduction for the existing Swift snapshot decoder.
# Linux generation of dist/swift-payload.json is not a Mac execution result.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
payload="${1:-$root/dist/swift-payload.json}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "mac-swift-repro: this command is a Mac execution. Linux generation is not a Mac execution result." >&2
  echo "payload (credential-free): $payload" >&2
  exit 2
fi

if [[ ! -s "$payload" ]]; then
  echo "missing payload: $payload" >&2
  echo "generate on any host with: go run ./cmd/swiftpayload > dist/swift-payload.json" >&2
  exit 1
fi

# Existing decoder, not a new UI. Reads schemaVersion, selected keys, and expiry.
swift -e '
import Foundation
let path = CommandLine.arguments[1]
let data = try Data(contentsOf: URL(fileURLWithPath: path))
struct Window: Decodable { let id: String; let remainingPercent: Double?; let stale: Bool?; let resetAt: String? }
struct Account: Decodable { let id: String; let status: String; let updatedAt: String?; let windows: [Window] }
struct Provider: Decodable { let id: String; let accounts: [Account] }
struct Snapshot: Decodable { let schemaVersion: Int; let observedAt: String; let providers: [Provider] }
let snap = try JSONDecoder().decode(Snapshot.self, from: data)
precondition(snap.schemaVersion == 1, "schemaVersion")
precondition(!snap.providers.isEmpty, "providers")
print("mac-swift-repro: decoded schemaVersion=\(snap.schemaVersion) providers=\(snap.providers.count)")
' "$payload"

echo "mac-swift-repro: also run the in-repo decoder tests:"
echo "  swift macos/Tests/QuotaModelTests.swift"
