/*
**	Command & Conquer Generals(tm)
**	Copyright 2025 Electronic Arts Inc.
**
**	This program is free software: you can redistribute it and/or modify
**	it under the terms of the GNU General Public License as published by
**	the Free Software Foundation, either version 3 of the License, or
**	(at your option) any later version.
**
**	This program is distributed in the hope that it will be useful,
**	but WITHOUT ANY WARRANTY; without even the implied warranty of
**	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
**	GNU General Public License for more details.
**
**	You should have received a copy of the GNU General Public License
**	along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

/*
** WebMain.cpp
**
** Entry point for the Emscripten (WebAssembly) build of the base game.
**
** GeneralsX @build caiiiycuk 14/08/2026 Web entry point for base Generals.
** Adapted from GeneralsMD/Code/Main/WebMain.cpp (the Zero Hour web entry);
** the only differences are branding and the asset root: the base game's
** primary assets live in GX_OPFS_BASE/GameDataGenerals (the same directory
** ZH loads them from as its secondary asset set), resolved through
** CNC_GENERALS_PATH instead of CNC_GENERALS_ZH_PATH.
**  - No Vulkan/DXVK: rendering goes through the statically linked d3d8webgl
**    library (D3D8 -> WebGL2), created by DX8Wrapper::Init() directly.
**  - Game data lives in OPFS (Origin Private File System) under the
**    ccgenerals/ subdirectory; the deployer provisions it before the wasm
**    module starts. The OPFS root is mounted at /opfs via WASMFS.
**  - main() runs on a dedicated pthread (-sPROXY_TO_PTHREAD), so the engine's
**    blocking GameEngine::execute() loop and synchronous fread() over OPFS
**    access handles are both legal here.
*/

#ifdef __EMSCRIPTEN__

// SYSTEM INCLUDES
#include <SDL3/SDL.h>
#include <emscripten.h>
#include <emscripten/threading.h>
#include <emscripten/wasmfs.h>
#include <cstdlib>
#include <cstring>
#include <cstdio>
#include <string>
#include <map>        // userdata write-back change cache
#include <vector>     // userdata write-back path list
#include <unistd.h>   // _exit(), chdir()
#include <sys/stat.h>
#include <dirent.h>   // userdata write-back walk

// d3d8webgl: native display mode published before device creation.
extern "C" void d3d8webgl_set_native_mode(int w, int h);

// libavutil (FFmpeg): silence swscale's per-open INFO chatter about missing
// SIMD paths - wasm has none by definition. Declared here to avoid pulling
// FFmpeg headers into the entry point; the C ABI is stable.
extern "C" void av_log_set_level(int level);

// Loader render-FPS setting, enforced per frame in gxWebPeriodic() through
// the engine's native render/logic decoupling (FramePacer).
static int s_gxFpsSetting = 0;

// USER INCLUDES (match SDL3Main.cpp pattern)
#include "Lib/BaseType.h"
#include "Common/CommandLine.h"
#include "Common/CriticalSection.h"
#include "Common/GlobalData.h"
#include "Common/GameEngine.h"
#include "Common/FramePacer.h"
#include "Common/GameMemory.h"
#include "Common/Debug.h"
#include "Common/version.h"
#include "SDL3GameEngine.h"

// CRITICAL SECTIONS (same set as SDL3Main.cpp)
static CriticalSection critSec1;
static CriticalSection critSec2;
static CriticalSection critSec3;
static CriticalSection critSec4;
static CriticalSection critSec5;

// GLOBAL COMMAND LINE ARGUMENTS (CommandLine.cpp reads these on non-Windows)
int __argc = 0;          ///< global argument count
char** __argv = nullptr; ///< global argument vector

// GLOBAL WINDOW HANDLE (SDL_Window* cast to HWND for engine compatibility)
HWND ApplicationHWnd = nullptr;

// GLOBAL SDL3 WINDOW (SDL3GameEngine reads this)
SDL_Window* TheSDL3Window = nullptr;

// GAME TEXT FILE PATHS (GameText.cpp; lowercase for case-sensitive FS)
const Char *g_csfFile = "data/%s/generals.csf";
const Char *g_strFile = "data/Generals.str";

// Extern declarations (from GameMain.cpp)
extern Int GameMain();

/**
 * CreateGameEngine
 *
 * Factory for the platform engine. The web build reuses SDL3GameEngine -
 * SDL3's Emscripten backend delivers input/window events from the canvas.
 */
GameEngine *CreateGameEngine(void)
{
	fprintf(stderr, "INFO: CreateGameEngine() - Creating SDL3GameEngine for Web\n");
	SDL3GameEngine *engine = NEW SDL3GameEngine();
	return engine;
}

// GeneralsX @feature caiiiycuk 14/08/2026 Keep all game state in one OPFS
// subdirectory (ccgenerals/) instead of the shared origin-wide OPFS root.
// The torrent deployer and the JS shell (storage.js) use the same base.
#define GX_OPFS_BASE "/opfs/ccgenerals"

// GeneralsX @feature caiiiycuk 14/08/2026 Userdata (Options.ini, saves,
// replays) lives on its own js-file mount backed by the gx-userdata IndexedDB
// database (see storage.js) - separate from the torrent-deployed OPFS game
// data, so asset redeploys and wipes never touch user files. Shared with the
// ZH engine: the games keep separate subtrees under GeneralsX/.
#define GX_USER_BASE "/idb"
#define GX_USER_DATA_DIR GX_USER_BASE "/userdata"

// Base-game asset root inside the shared ccgenerals/ layout. ZH owns
// GameData/; the base game's .big set lives in the sibling GameDataGenerals/
// (the same directory ZH consumes as its secondary asset source).
#define GX_ASSET_DIR GX_OPFS_BASE "/GameDataGenerals"

/**
 * PopulateFromIdb
 *
 * IndexedDB fallback (no OPFS in this browser/context): the JS loader has
 * materialized every asset as an ArrayBuffer on window.gxFiles (main thread).
 * Copy them, chunk by chunk through a small wasm-heap buffer, into the
 * js-file-backend mount. File payloads then live in JS memory (NOT the wasm
 * heap), so a large asset set does not eat the heap.
 *
 * The JS storage layer keys base-game assets with the GameDataGenerals/
 * prefix and ZH assets without one (see gxStoragePath() in storage.js); the
 * unprefixed ZH files land in GameData/ and are simply unused by this build.
 *
 * MAIN_THREAD_EM_ASM blocks this pthread while the JS runs on the main
 * thread; the copies via HEAPU8 are plain SharedArrayBuffer writes.
 */
static bool PopulateFromIdb()
{
	const int fileCount = MAIN_THREAD_EM_ASM_INT({
		return (typeof window !== 'undefined' && window.gxFiles) ? window.gxFiles.length : 0;
	});
	if (fileCount == 0) {
		fprintf(stderr, "FATAL: IndexedDB mode but window.gxFiles is empty - loader did not materialize assets\n");
		return false;
	}
	fprintf(stderr, "INFO: populating " GX_OPFS_BASE " from IndexedDB (%d files)...\n", fileCount);

	const size_t kChunk = 8u * 1024u * 1024u;
	char *chunk = (char *)malloc(kChunk);
	char pathBuf[1024];

	for (int i = 0; i < fileCount; i++) {
		MAIN_THREAD_EM_ASM({
			stringToUTF8(window.gxFiles[$0].path, $1, $2);
		}, i, pathBuf, (int)sizeof(pathBuf));

		const double sizeD = MAIN_THREAD_EM_ASM_DOUBLE({
			return window.gxFiles[$0].data.byteLength;
		}, i);
		const size_t size = (size_t)sizeD;

		// Same path mapping as the ZH build: GameDataGenerals/ and userdata/
		// prefixed paths are GX_OPFS_BASE siblings of GameData/, everything
		// else belongs to the ZH install under GameData/.
		std::string full = (strncmp(pathBuf, "GameDataGenerals/", 17) == 0 ||
		                    strncmp(pathBuf, "userdata/", 9) == 0)
			? std::string(GX_OPFS_BASE "/") + pathBuf
			: std::string(GX_OPFS_BASE "/GameData/") + pathBuf;
		for (size_t p = strlen("/opfs/"); p < full.size(); p++) {
			if (full[p] == '/') {
				std::string dir = full.substr(0, p);
				mkdir(dir.c_str(), 0777);
			}
		}

		FILE *fp = fopen(full.c_str(), "wb");
		if (!fp) {
			fprintf(stderr, "FATAL: cannot create %s in js-file backend\n", full.c_str());
			free(chunk);
			return false;
		}
		for (size_t off = 0; off < size; off += kChunk) {
			const size_t n = (size - off) < kChunk ? (size - off) : kChunk;
			MAIN_THREAD_EM_ASM({
				HEAPU8.set(new Uint8Array(window.gxFiles[$0].data, $1, $2), $3);
			}, i, (double)off, (double)n, chunk);
			if (fwrite(chunk, 1, n, fp) != n) {
				fprintf(stderr, "FATAL: short write for %s\n", full.c_str());
				fclose(fp);
				free(chunk);
				return false;
			}
		}
		fclose(fp);

		// Free the JS-side copy as we go to halve peak memory.
		MAIN_THREAD_EM_ASM({ window.gxFiles[$0].data = null; }, i);
	}

	free(chunk);
	MAIN_THREAD_EM_ASM({ window.gxFiles = null; });
	fprintf(stderr, "INFO: IndexedDB population complete\n");
	return true;
}

/**
 * PopulateUserdataFromIdb
 *
 * Restore the userdata tree (Options.ini, saves, replays) from the
 * gx-userdata IndexedDB database into the js-file mount at GX_USER_DATA_DIR.
 * The JS loader has materialized the files as ArrayBuffers on
 * window.gxUserFiles (main thread) before the module started.
 * Returns the number of files restored.
 *
 * GeneralsX @feature caiiiycuk 14/08/2026
 */
static int PopulateUserdataFromIdb()
{
	const int fileCount = MAIN_THREAD_EM_ASM_INT({
		return (typeof window !== 'undefined' && window.gxUserFiles) ? window.gxUserFiles.length : 0;
	});

	char pathBuf[1024];
	int restored = 0;
	for (int i = 0; i < fileCount; i++) {
		MAIN_THREAD_EM_ASM({
			stringToUTF8(window.gxUserFiles[$0].path, $1, $2);
		}, i, pathBuf, (int)sizeof(pathBuf));

		const double sizeD = MAIN_THREAD_EM_ASM_DOUBLE({
			return window.gxUserFiles[$0].data.byteLength;
		}, i);
		const size_t size = (size_t)sizeD;

		std::string full = std::string(GX_USER_DATA_DIR "/") + pathBuf;
		for (size_t p = strlen(GX_USER_BASE) + 1; p < full.size(); p++) {
			if (full[p] == '/') {
				mkdir(full.substr(0, p).c_str(), 0777);
			}
		}

		FILE *fp = fopen(full.c_str(), "wb");
		if (!fp) {
			fprintf(stderr, "WARNING: cannot restore userdata file %s\n", full.c_str());
			continue;
		}
		std::string bytes(size, '\0');
		if (size > 0) {
			MAIN_THREAD_EM_ASM({
				HEAPU8.set(new Uint8Array(window.gxUserFiles[$0].data), $1);
			}, i, &bytes[0]);
		}
		if (size == 0 || fwrite(bytes.data(), 1, size, fp) == size) {
			restored++;
		}
		fclose(fp);
	}

	MAIN_THREAD_EM_ASM({ window.gxUserFiles = null; });
	if (restored > 0) {
		fprintf(stderr, "INFO: restored %d userdata file(s) from IndexedDB\n", restored);
	}
	return restored;
}

/**
 * MigrateLegacyUserdata
 *
 * One-time migration: older builds kept userdata inside the OPFS game-data
 * tree (GX_OPFS_BASE/userdata). Copy it into the IndexedDB-backed mount; the
 * periodic write-back then persists it into gx-userdata.
 *
 * GeneralsX @feature caiiiycuk 14/08/2026
 */
static void MigrateLegacyUserdata(const std::string &src, const std::string &dst)
{
	DIR *d = opendir(src.c_str());
	if (!d) return;
	mkdir(dst.c_str(), 0777);
	while (struct dirent *e = readdir(d)) {
		if (e->d_name[0] == '.') continue;
		const std::string s = src + "/" + e->d_name;
		const std::string t = dst + "/" + e->d_name;
		struct stat st;
		if (stat(s.c_str(), &st) != 0) continue;
		if (S_ISDIR(st.st_mode)) {
			MigrateLegacyUserdata(s, t);
			continue;
		}
		FILE *in = fopen(s.c_str(), "rb");
		if (!in) continue;
		FILE *out = fopen(t.c_str(), "wb");
		if (!out) { fclose(in); continue; }
		char buf[65536];
		size_t n;
		while ((n = fread(buf, 1, sizeof(buf), in)) > 0) {
			fwrite(buf, 1, n, out);
		}
		fclose(in);
		fclose(out);
		fprintf(stderr, "INFO: migrated legacy userdata file %s\n", t.c_str());
	}
	closedir(d);
}

/**
 * gxWebPeriodic
 *
 * Called once per frame from the GameEngine web tick. The userdata mount is a
 * session-local js-file backend, so every ~10s (and once more on quit via
 * gxWebFlushUserdata) changed files are pushed back to the gx-userdata
 * IndexedDB database via window.gxIdbPutUserFile, and files deleted in-game
 * are pruned via window.gxIdbPruneUserFiles.
 */
static bool s_gxIdbMode = false;

// (size, mtime) per relative path: skip unchanged files so the periodic
// write-back pass stays cheap.
static std::map<std::string, std::pair<long long, long long> > s_gxUserBackupCache;

static void GxBackupUserdataDir(const std::string &dir, const std::string &rel,
                                std::vector<std::string> &seen, bool &changed)
{
	DIR *d = opendir(dir.c_str());
	if (!d) return;
	while (struct dirent *e = readdir(d)) {
		if (e->d_name[0] == '.') continue;
		const std::string full = dir + "/" + e->d_name;
		const std::string relPath = rel.empty() ? e->d_name : rel + "/" + e->d_name;
		struct stat st;
		if (stat(full.c_str(), &st) != 0) continue;
		if (S_ISDIR(st.st_mode)) {
			GxBackupUserdataDir(full, relPath, seen, changed);
			continue;
		}
		seen.push_back(relPath);
		const std::pair<long long, long long> sig((long long)st.st_size, (long long)st.st_mtime);
		std::map<std::string, std::pair<long long, long long> >::iterator it = s_gxUserBackupCache.find(relPath);
		if (it != s_gxUserBackupCache.end() && it->second == sig) continue;
		FILE *fp = fopen(full.c_str(), "rb");
		if (!fp) continue;
		std::string bytes((size_t)st.st_size, '\0');
		const size_t got = fread(&bytes[0], 1, bytes.size(), fp);
		fclose(fp);
		if (got != bytes.size()) continue;
		MAIN_THREAD_EM_ASM({
			if (window.gxIdbPutUserFile) {
				window.gxIdbPutUserFile(UTF8ToString($0), HEAPU8.slice($1, $1 + $2));
			}
		}, relPath.c_str(), bytes.data(), (int)bytes.size());
		s_gxUserBackupCache[relPath] = sig;
		changed = true;
	}
	closedir(d);
}

// Full write-back pass: push changed files into gx-userdata and prune records
// whose files were deleted in-game (saves, replays). Also called from the
// GameEngine web tick right before quit (_exit) for a final flush.
extern "C" void gxWebFlushUserdata(void)
{
	std::vector<std::string> seen;
	bool changed = false;
	GxBackupUserdataDir(GX_USER_DATA_DIR, "", seen, changed);
	if (seen.size() != s_gxUserBackupCache.size()) changed = true;
	if (!changed) return;

	// Drop cache entries for files that no longer exist, then let JS prune
	// the IndexedDB records not on the survivor list.
	std::map<std::string, std::pair<long long, long long> >::iterator it = s_gxUserBackupCache.begin();
	while (it != s_gxUserBackupCache.end()) {
		bool found = false;
		for (size_t i = 0; i < seen.size(); i++) {
			if (seen[i] == it->first) { found = true; break; }
		}
		if (!found) s_gxUserBackupCache.erase(it++);
		else ++it;
	}
	std::string joined;
	for (size_t i = 0; i < seen.size(); i++) {
		joined += seen[i];
		joined += '\n';
	}
	MAIN_THREAD_EM_ASM({
		if (window.gxIdbPruneUserFiles) {
			window.gxIdbPruneUserFiles(UTF8ToString($0).split('\n').filter(Boolean));
		}
	}, joined.c_str());
}

extern "C" void gxWebPeriodic(void)
{
	// Render-FPS setting: raise the render limit while keeping the current
	// engine limit as the LOGIC rate (= game speed). Re-applied every frame
	// because in-game code rewrites the limit (skirmish game-speed slider,
	// script actions).
	if (s_gxFpsSetting > 30 && TheFramePacer) {
		const Int cur = TheFramePacer->getFramesPerSecondLimit();
		if (cur > 0 && cur < s_gxFpsSetting) {
			TheFramePacer->setLogicTimeScaleFps(cur);
			TheFramePacer->enableLogicTimeScale(true);
			TheFramePacer->setFramesPerSecondLimit(s_gxFpsSetting);
		}
	}

	static double s_last = 0.0;
	const double now = emscripten_get_now();
	if (now - s_last < 10000.0) return; // every ~10s
	s_last = now;
	gxWebFlushUserdata();
}

/**
 * MountGameStorage
 *
 * Mounts persistent storage at /opfs and points the engine's path
 * resolution at the game's own subdirectory (GX_OPFS_BASE = /opfs/ccgenerals):
 *   GX_ASSET_DIR (= GX_OPFS_BASE/GameDataGenerals)
 *                          - read-only base-game assets (.big set, Data/,
 *                            Maps/, fonts/)
 *   GX_OPFS_BASE/userdata  - saves, Options.ini, replays (XDG_DATA_HOME branch
 *                            of GlobalData::BuildUserDataPathFromRegistry()).
 *
 * Preferred backend is OPFS (Module.gxStorageMode == 0): the deployer wrote
 * the files into OPFS before main() started; synchronous access handles work
 * here because -sPROXY_TO_PTHREAD runs main() on a pthread.
 *
 * Fallback (gxStorageMode == 1) is the IndexedDB path: a js-file backend is
 * mounted instead and populated from window.gxFiles (see PopulateFromIdb).
 */
static bool MountGameStorage()
{
	const int mode = MAIN_THREAD_EM_ASM_INT({
		return (typeof Module !== 'undefined' && Module.gxStorageMode) ? Module.gxStorageMode : 0;
	});

	backend_t backend = nullptr;
	if (mode == 0) {
		backend = wasmfs_create_opfs_backend();
		if (backend == nullptr) {
			fprintf(stderr, "FATAL: wasmfs_create_opfs_backend() failed (OPFS unavailable?)\n");
			return false;
		}
	} else {
		backend = wasmfs_create_js_file_backend();
		if (backend == nullptr) {
			fprintf(stderr, "FATAL: wasmfs_create_js_file_backend() failed\n");
			return false;
		}
	}

	int rc = wasmfs_create_directory("/opfs", 0777, backend);
	if (rc != 0) {
		fprintf(stderr, "FATAL: mounting storage at /opfs failed (rc=%d)\n", rc);
		return false;
	}

	s_gxIdbMode = (mode != 0);
	mkdir(GX_OPFS_BASE, 0777); // harmless if the deployer already made it
	if (mode != 0) {
		mkdir(GX_ASSET_DIR, 0777);
		if (!PopulateFromIdb()) {
			return false;
		}
	}

	// Asset root: StdBIGFileSystem::resolvePrimaryAssetDirectory() checks this
	// env var first (the RTS_GENERALS build reads CNC_GENERALS_PATH);
	// everything else (Data/, Maps/) resolves from the CWD.
	setenv("CNC_GENERALS_PATH", GX_ASSET_DIR, 1);

	// GeneralsX @feature caiiiycuk 14/08/2026 UI language from the URL (?lang=).
	// The deployed data is an English install with Russian override archives
	// on top (00Russian.big/0!Russian.big). Unless the page asks for ?lang=ru
	// (game.js -> Module.gxLang), hide those archives from the engine
	// (GX_SKIP_BIGS, see StdBIGFileSystem) so the same OPFS deployment also
	// serves plain English.
	const int langIsRu = MAIN_THREAD_EM_ASM_INT({
		return (typeof Module !== 'undefined' && Module.gxLang === 'ru') ? 1 : 0;
	});
	if (!langIsRu) {
		setenv("GX_SKIP_BIGS", "00RussianZH.big,00Russian.big,0!Russian.big", 1);
		fprintf(stderr, "INFO: lang != ru -> Russian override archives hidden (GX_SKIP_BIGS)\n");
	}

	// GeneralsX @feature caiiiycuk 14/08/2026 Userdata mount: js-file backend
	// at GX_USER_BASE, persisted in the gx-userdata IndexedDB database. The JS
	// loader restored the files into window.gxUserFiles before the module
	// started; gxWebPeriodic() writes changes back every ~10s plus a final
	// flush on quit.
	backend_t userBackend = wasmfs_create_js_file_backend();
	if (userBackend == nullptr || wasmfs_create_directory(GX_USER_BASE, 0777, userBackend) != 0) {
		fprintf(stderr, "FATAL: mounting userdata storage at " GX_USER_BASE " failed\n");
		return false;
	}
	mkdir(GX_USER_DATA_DIR, 0777);
	if (PopulateUserdataFromIdb() == 0) {
		// One-time migration: older builds kept userdata inside the OPFS tree.
		MigrateLegacyUserdata(GX_OPFS_BASE "/userdata", GX_USER_DATA_DIR);
	}

	// User data: GlobalData::BuildUserDataPathFromRegistry() Linux/XDG branch
	// yields $XDG_DATA_HOME/GeneralsX/Generals/.
	setenv("XDG_DATA_HOME", GX_USER_DATA_DIR, 1);

	if (chdir(GX_ASSET_DIR) != 0) {
		fprintf(stderr, "WARNING: chdir(" GX_ASSET_DIR ") failed - assets not deployed yet?\n");
		return false;
	}

	fprintf(stderr, "INFO: game storage mounted at /opfs (%s; assets: " GX_ASSET_DIR ", userdata: " GX_OPFS_BASE "/userdata)\n",
	        mode == 0 ? "OPFS" : "IndexedDB via js-file backend");
	return true;
}

/**
 * main
 *
 * Web entry point. Runs on a dedicated pthread (PROXY_TO_PTHREAD).
 */
int main(int argc, char* argv[])
{
	int exitcode = 1;

	__argc = argc;
	__argv = argv;

	// GeneralsX @tweak caiiiycuk 14/08/2026 Web ships without any base-game
	// videos, so force -nologo: a stale OPFS deployment may still contain the
	// intro movies and would play them otherwise.
	{
		static char nologoFlag[] = "-nologo";
		static char* argvNoLogo[64];
		int n = 0;
		for (int i = 0; i < __argc && n < 62; ++i)
			argvNoLogo[n++] = __argv[i];
		argvNoLogo[n++] = nologoFlag;
		argvNoLogo[n] = nullptr;
		__argv = argvNoLogo;
		__argc = n;
	}

	fprintf(stderr, "=================================================\n");
	fprintf(stderr, " Command & Conquer Generals (Web)\n");
	fprintf(stderr, " Emscripten + SDL3 + d3d8webgl Build\n");
	fprintf(stderr, "=================================================\n\n");

	// Mount persistent storage before anything touches the file system (INI,
	// Options.ini, BIG archives are all read during GameMain()).
	if (!MountGameStorage()) {
		fprintf(stderr, "FATAL: game storage mount failed; cannot continue\n");
		return 1;
	}

	try {
		// Initialize critical sections (required by game engine)
		TheAsciiStringCriticalSection = &critSec1;
		TheUnicodeStringCriticalSection = &critSec2;
		TheDmaCriticalSection = &critSec3;
		TheMemoryPoolCriticalSection = &critSec4;
		TheDebugLogCriticalSection = &critSec5;

		// Initialize memory manager early (required by NEW operator)
		initMemoryManager();

		// Version singleton must exist before GameMain() (window title update)
		TheVersion = NEW Version;

		// Parse command line (JS side passes flags via Module.arguments)
		CommandLine::parseCommandLineForStartup();

		const bool isHeadlessMode = (TheGlobalData != nullptr && TheGlobalData->m_headless);
		if (isHeadlessMode) {
			fprintf(stderr, "INFO: Headless mode detected, skipping SDL3 window initialization\n");
		} else {
			fprintf(stderr, "INFO: Initializing SDL3 video subsystem...\n");
			if (!SDL_InitSubSystem(SDL_INIT_VIDEO | SDL_INIT_AUDIO)) {
				fprintf(stderr, "FATAL: Failed to initialize SDL3: %s\n", SDL_GetError());
				return 1;
			}

			// Plain window: no SDL_WINDOW_VULKAN and no SDL_WINDOW_OPENGL.
			// The d3d8webgl renderer creates its own WebGL2 context on the
			// canvas (transferred to this pthread via OFFSCREENCANVAS); SDL
			// only delivers input and window events.
			fprintf(stderr, "INFO: Creating SDL3 window (canvas)...\n");
			TheSDL3Window = SDL_CreateWindow(
				"Command & Conquer Generals",
				1024, 768,
				SDL_WINDOW_RESIZABLE
			);

			if (!TheSDL3Window) {
				fprintf(stderr, "FATAL: Failed to create SDL3 window: %s\n", SDL_GetError());
				SDL_Quit();
				return 1;
			}

			ApplicationHWnd = (HWND)TheSDL3Window;
			fprintf(stderr, "INFO: SDL3 window created successfully\n");

			// On Emscripten the canvas must be sized to the actual viewport
			// before any SDL size query or resolution injection - otherwise
			// the canvas defaults to 1024x768 (the SDL_CreateWindow size)
			// and is centre-fitted into the viewport, producing black bars
			// until the user triggers a resize.
			int vpW = MAIN_THREAD_EM_ASM_INT({ return window.innerWidth; });
			int vpH = MAIN_THREAD_EM_ASM_INT({ return window.innerHeight; });
			SDL_SetWindowSize(TheSDL3Window, vpW, vpH);
			// d3d8webgl_set_native_mode is called from the resolution block below.

			// Match the engine's internal resolution to the SDL window/canvas
			// (same pattern as the iOS port): injected as -xres/-yres argv so
			// the normal command-line path applies them unless the user passed
			// explicit values via ?args=.
			{
				bool userSetRes = false;
				for (int i = 1; i < __argc; ++i) {
					if (strcmp(__argv[i], "-xres") == 0 || strcmp(__argv[i], "-yres") == 0) {
						userSetRes = true;
						break;
					}
				}
				int winW = 0, winH = 0;
				SDL_GetWindowSizeInPixels(TheSDL3Window, &winW, &winH);
				// GeneralsX @feature caiiiycuk 14/08/2026 HiDPI: SDL reports the
				// canvas CSS size; render at physical-pixel resolution instead
				// (devicePixelRatio, capped at 2x to bound WebGL fill rate on 4K
				// displays). The SDL window stays CSS-sized - mouse input keeps
				// working because SDL3Mouse::scaleMouseCoordinates() maps window
				// coordinates onto the internal resolution.
				double dpr = MAIN_THREAD_EM_ASM_DOUBLE({
					return Math.min(window.devicePixelRatio || 1, 2);
				});
				if (dpr < 1.0) dpr = 1.0;
				winW = (int)(winW * dpr);
				winH = (int)(winH * dpr);
				// Publish the native mode to d3d8webgl BEFORE the device is
				// created: DX8Wrapper only accepts a 32-bit backbuffer if mode
				// enumeration contains this exact resolution (else the whole
				// game degrades to 16-bit textures).
				d3d8webgl_set_native_mode(winW & ~1, winH & ~1);
				if (!userSetRes && winW >= 640 && winH >= 480) {
					static char xresVal[16], yresVal[16];
					static char xresFlag[] = "-xres";
					static char yresFlag[] = "-yres";
					snprintf(xresVal, sizeof(xresVal), "%d", winW & ~1);
					snprintf(yresVal, sizeof(yresVal), "%d", winH & ~1);
					static char* newArgv[64];
					int n = 0;
					for (int i = 0; i < __argc && n < 59; ++i) {
						newArgv[n++] = __argv[i];
					}
					newArgv[n++] = xresFlag;
					newArgv[n++] = xresVal;
					newArgv[n++] = yresFlag;
					newArgv[n++] = yresVal;
					newArgv[n] = nullptr;
					__argv = newArgv;
					__argc = n;
					fprintf(stderr, "INFO: Web internal resolution set to %sx%s\n", xresVal, yresVal);
				}
			}
		}

		// FFmpeg: errors only (16 = AV_LOG_ERROR). Some video paths create
		// swscale contexts before FFmpegFile::open() runs, so set it here.
		av_log_set_level(16);

		// Loader FPS setting (Module.gxFps): enforced each frame in
		// gxWebPeriodic() through FramePacer's render/logic decoupling.
		s_gxFpsSetting = MAIN_THREAD_EM_ASM_INT({
			return (typeof Module !== 'undefined' && Module.gxFps) ? (Module.gxFps | 0) : 0;
		});
		if (s_gxFpsSetting > 30) {
			fprintf(stderr, "INFO: render FPS setting: %d (logic stays at the game-speed value)\n", s_gxFpsSetting);
		}

		// Call cross-platform game entry point
		exitcode = GameMain();

		// GameMain() returned with the rAF main loop registered and the
		// engine still alive (see GameEngine::execute web branch). Keep the
		// wasm runtime (and this pthread) alive; NONE of the teardown below
		// may run. Quit terminates from inside the loop tick (_exit).
		fprintf(stderr, "INFO: main loop armed; keeping runtime alive\n");
		emscripten_exit_with_live_runtime();

		fprintf(stderr, "INFO: GameMain() returned with code %d\n", exitcode);

	} catch (const std::exception& e) {
		fprintf(stderr, "FATAL: Unhandled exception in main(): %s\n", e.what());
		exitcode = 1;
	} catch (...) {
		fprintf(stderr, "FATAL: Unknown exception in main()\n");
		exitcode = 1;
	}

	// Cleanup SDL3 resources
	if (TheSDL3Window) {
		SDL_DestroyWindow(TheSDL3Window);
		TheSDL3Window = nullptr;
		ApplicationHWnd = nullptr;
	}
	SDL_Quit();

	if (TheVersion) {
		delete TheVersion;
		TheVersion = nullptr;
	}

	// Same shutdown order as SDL3Main.cpp: memory manager before critSec nulling.
	shutdownMemoryManager();

	TheAsciiStringCriticalSection = nullptr;
	TheUnicodeStringCriticalSection = nullptr;
	TheDmaCriticalSection = nullptr;
	TheMemoryPoolCriticalSection = nullptr;
	TheDebugLogCriticalSection = nullptr;

	fprintf(stderr, "\nExiting with code %d\n", exitcode);

	// Skip C++ global destructors (see SDL3Main.cpp rationale: pool dtors
	// crash after game shutdown reused their memory). Terminates the wasm
	// runtime; the page-side JS shows a "game exited" panel.
	_exit(exitcode);
}

#endif // __EMSCRIPTEN__
