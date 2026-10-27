#!/bin/sh
# Installs the .NET SDKs and the bundled Roslyn analyzers of plan 2D (config.md §6.1) and phase 8A
# into $QUALOR_TOOLS (default /opt/qualor): the .NET 8 and .NET 10 SDKs side by side in share/dotnet
# (so SDK 10 finds the net8.0 targeting pack locally), `dotnet` linked into bin, Roslynator.Analyzers'
# roslyn4.7/cs DLLs in dotnet/analyzers, and SonarAnalyzer.CSharp's analyzers/ DLLs in their own
# dotnet/analyzers/sonar subdirectory. Every download is checked against its pinned hash before it
# is unpacked. The SDK hashes are Microsoft's SHA-512 from
# https://builds.dotnet.microsoft.com/dotnet/release-metadata/<channel>/releases.json.
# Debian or Ubuntu with curl, tar, unzip; the SDK's native dependencies are installed with apt.
set -eu

DOTNET8_VERSION=8.0.427
DOTNET8_SHA512_X64=85725692f465f5024b9b42a159a29d9f73e8c57ad9e8bfe1e7028a505d18031d68931e8aa3f9de44145b08170dde897c8a78e1aa18d4219698b6891af7095d39
DOTNET8_SHA512_ARM64=2b851de08e94922b382d1d2754df112cd167f6e9b6f3d15d2cfe143fded1d5b05d6b196b545941d22c97db62bb426d71a4fe6e131a92e482c6ea1a7337ffedab
DOTNET10_VERSION=10.0.403
DOTNET10_SHA512_X64=b7b3d8461cf98b07d2552ce9199702fa3ad010ac2671a5f8cd5136f7534e50f6855ba7bbb02b11494563f1d04156276a31cda1103b900e5eecd0d9473dc7b9c5
DOTNET10_SHA512_ARM64=0966aa2b70f4677b8319be9df447a78a0dcd6164836425b55a68fd714f4023feb87b4cac21b9a996b79472ad54487cd0adcd2a9dfd570e2b2a1d26423a2baa9b
ROSLYNATOR_VERSION=5.0.0
ROSLYNATOR_SHA256=e5623ec990957c5ab9fd8ff23992d63c0d4c5571f4383f913d8af9886e18277b
# SonarAnalyzer.CSharp 9.32.0.97167 is the last LGPL-3.0 release; 10.x is under the SONAR
# Source-Available License, which forbids use in a product competing with SonarQube. Never bump.
SONARANALYZER_VERSION=9.32.0.97167
SONARANALYZER_SHA256=17c7fd6230597a4c08a30226e8b29f8e8c2a982ca12d4b9315021c8c41150cf8

PREFIX="${QUALOR_TOOLS:-/opt/qualor}"
case "$(uname -m)" in
  x86_64 | amd64) ARCH=x64; SHA8=$DOTNET8_SHA512_X64; SHA10=$DOTNET10_SHA512_X64 ;;
  aarch64 | arm64) ARCH=arm64; SHA8=$DOTNET8_SHA512_ARM64; SHA10=$DOTNET10_SHA512_ARM64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

if command -v apt-get >/dev/null 2>&1; then
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl unzip libicu72 libgssapi-krb5-2 libssl3 zlib1g \
    || apt-get install -y --no-install-recommends ca-certificates curl unzip libicu74 libgssapi-krb5-2 libssl3t64 zlib1g
  rm -rf /var/lib/apt/lists/*
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
get() { # url file
  curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 7 --retry-connrefused -o "$TMP/$2" "$1"
}

DOTNET_ROOT="$PREFIX/share/dotnet"
mkdir -p "$DOTNET_ROOT" "$PREFIX/bin" "$PREFIX/dotnet/analyzers"
for pair in "$DOTNET8_VERSION:$SHA8" "$DOTNET10_VERSION:$SHA10"; do
  v="${pair%%:*}"; sha="${pair#*:}"
  get "https://builds.dotnet.microsoft.com/dotnet/Sdk/$v/dotnet-sdk-$v-linux-$ARCH.tar.gz" "sdk-$v.tgz"
  echo "$sha  $TMP/sdk-$v.tgz" | sha512sum -c - >/dev/null || { echo "checksum mismatch: .NET SDK $v" >&2; exit 1; }
  tar -xzf "$TMP/sdk-$v.tgz" --no-same-owner -C "$DOTNET_ROOT"
  # Both SDKs share one DOTNET_ROOT (D11), so the second tar's top-level LICENSE.txt and
  # ThirdPartyNotices.txt would silently overwrite the first SDK's (licence gate, AGENTS.md rule
  # 7: every shipped component's notices must actually be auditable). Keep a per-version copy of
  # each before that happens; the unsuffixed files are left as whichever SDK was extracted last.
  cp "$DOTNET_ROOT/LICENSE.txt" "$DOTNET_ROOT/LICENSE-$v.txt"
  cp "$DOTNET_ROOT/ThirdPartyNotices.txt" "$DOTNET_ROOT/ThirdPartyNotices-$v.txt"
done
ln -sf "$DOTNET_ROOT/dotnet" "$PREFIX/bin/dotnet"

get "https://api.nuget.org/v3-flatcontainer/roslynator.analyzers/$ROSLYNATOR_VERSION/roslynator.analyzers.$ROSLYNATOR_VERSION.nupkg" roslynator.nupkg
echo "$ROSLYNATOR_SHA256  $TMP/roslynator.nupkg" | sha256sum -c - >/dev/null || { echo "checksum mismatch: Roslynator $ROSLYNATOR_VERSION" >&2; exit 1; }
unzip -q -j -o "$TMP/roslynator.nupkg" 'analyzers/dotnet/roslyn4.7/cs/*.dll' -d "$PREFIX/dotnet/analyzers"
chmod 0644 "$PREFIX"/dotnet/analyzers/*.dll

# SonarAnalyzer.CSharp's DLLs go in their own subdirectory, not next to Roslynator's: `qualor
# dotnet begin` reads every *.dll directly in dotnet/analyzers as the Roslynator family, and reads
# dotnet/analyzers/sonar as its own family.
get "https://api.nuget.org/v3-flatcontainer/sonaranalyzer.csharp/$SONARANALYZER_VERSION/sonaranalyzer.csharp.$SONARANALYZER_VERSION.nupkg" sonar.nupkg
echo "$SONARANALYZER_SHA256  $TMP/sonar.nupkg" | sha256sum -c - >/dev/null || { echo "checksum mismatch: SonarAnalyzer.CSharp $SONARANALYZER_VERSION" >&2; exit 1; }
mkdir -p "$PREFIX/dotnet/analyzers/sonar"
unzip -q -j -o "$TMP/sonar.nupkg" 'analyzers/*.dll' -d "$PREFIX/dotnet/analyzers/sonar"
chmod 0644 "$PREFIX"/dotnet/analyzers/sonar/*.dll
# The package's own third-party notices (Google.Protobuf, BSD-3-Clause; the StyleCop Lightup, MIT,
# and Roslyn, Apache-2.0, code in its ShimLayer), verbatim from the checked nupkg, next to the
# other licence files. deploy/scanner/licenses/SONARANALYZER-CSHARP-LICENSE.txt quotes them too.
mkdir -p "$PREFIX/licenses"
unzip -q -p "$TMP/sonar.nupkg" 'license/THIRD-PARTY-NOTICES.txt' > "$PREFIX/licenses/SONARANALYZER-CSHARP-THIRD-PARTY-NOTICES.txt"
chmod 0644 "$PREFIX/licenses/SONARANALYZER-CSHARP-THIRD-PARTY-NOTICES.txt"

DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 "$PREFIX/bin/dotnet" --list-sdks
echo "installed .NET SDK $DOTNET8_VERSION and $DOTNET10_VERSION into $DOTNET_ROOT, Roslynator $ROSLYNATOR_VERSION and SonarAnalyzer.CSharp $SONARANALYZER_VERSION into $PREFIX/dotnet/analyzers"
