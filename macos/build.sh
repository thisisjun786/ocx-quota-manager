#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'Build on macOS with Xcode Command Line Tools.' >&2
  exit 1
fi
out="${QUOTA_BUILD_DIR:-$PWD/build}"
mkdir -p "$out/Quota Monitor.app/Contents/MacOS"
xcrun swiftc -swift-version 5 -parse-as-library Sources/QuotaModel.swift Tests/QuotaModelTests.swift -o "$out/model-tests"
"$out/model-tests"
xcrun swiftc -swift-version 5 -parse-as-library -O -target "$(uname -m)-apple-macosx13.0" Sources/*.swift -o "$out/Quota Monitor.app/Contents/MacOS/QuotaMonitor"
cp Info.plist "$out/Quota Monitor.app/Contents/Info.plist"
codesign --force --sign - "$out/Quota Monitor.app"
echo "$out/Quota Monitor.app"
