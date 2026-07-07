// vpk-helper: tiny CLI over ValvePak (the same library Source 2 Viewer uses) so
// the Rust/Tauri backend can produce game-valid Source 2 VPKs by shelling out.
//
// Commands:
//   pack    <sourceFolder> <outVpk>            pack a folder into a single _dir.vpk
//   extract <vpk> <internalPath> <outFile>     extract one file from a vpk
//   list    <vpk> [substring]                  list entry paths (optionally filtered)
//
// Output: a human line on success; errors go to stderr with a non-zero exit code.

using SteamDatabase.ValvePak;
using ValveResourceFormat;
using ValveResourceFormat.IO;
using ValveResourceFormat.ResourceTypes;
using SkiaSharp;

return args.Length == 0 ? Usage() : Dispatch(args);

static int Usage()
{
    Console.Error.WriteLine("usage: vpk-helper <pack|extract|list> ...");
    return 2;
}

static int Dispatch(string[] args)
{
    try
    {
        return args[0] switch
        {
            "pack" => Pack(args),
            "extract" => Extract(args),
            "list" => List(args),
            "crcs" => Crcs(args),
            "decode" => Decode(args),
            "decompile" => Decompile(args),
            "extractall" => ExtractAll(args),
            "decompileall" => DecompileAll(args),
            "texture" => TextureCmd(args),
            "texturebatch" => TextureBatch(args),
            "heroes" => Heroes(args),
            _ => Unknown(args[0]),
        };
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine("error: " + ex.Message);
        return 1;
    }
}

static int Unknown(string cmd)
{
    Console.Error.WriteLine($"unknown command: {cmd}");
    return 2;
}

// pack <sourceFolder> <outVpk>
static int Pack(string[] args)
{
    if (args.Length < 3)
    {
        Console.Error.WriteLine("usage: pack <sourceFolder> <outVpk>");
        return 2;
    }
    var folder = Path.GetFullPath(args[1]);
    var outVpk = Path.GetFullPath(args[2]);
    if (!Directory.Exists(folder))
    {
        Console.Error.WriteLine($"folder not found: {folder}");
        return 1;
    }

    // NOTE: do NOT SetFileName to a "*_dir.vpk" name — that puts the package in
    // directory-VPK mode, which ValvePak refuses to write. Writing to the path
    // directly produces a single-file vpk (all data inline), valid even when the
    // file is named pak01_dir.vpk (no external pak01_NNN.vpk archives).
    using var package = new Package();

    var count = 0;
    foreach (var file in Directory.EnumerateFiles(folder, "*", SearchOption.AllDirectories))
    {
        // Path INSIDE the vpk is the content-relative path with forward slashes.
        var rel = Path.GetRelativePath(folder, file).Replace('\\', '/');
        package.AddFile(rel, File.ReadAllBytes(file));
        count++;
    }

    var outDir = Path.GetDirectoryName(outVpk);
    if (!string.IsNullOrEmpty(outDir))
        Directory.CreateDirectory(outDir);

    package.Write(outVpk);
    Console.WriteLine($"packed {count} files -> {outVpk}");
    return 0;
}

// extract <vpk> <internalPath> <outFile>
static int Extract(string[] args)
{
    if (args.Length < 4)
    {
        Console.Error.WriteLine("usage: extract <vpk> <internalPath> <outFile>");
        return 2;
    }
    var vpk = Path.GetFullPath(args[1]);
    var internalPath = args[2].Replace('\\', '/').TrimStart('/');
    var outFile = Path.GetFullPath(args[3]);

    using var package = new Package();
    package.Read(vpk);

    var entry = package.FindEntry(internalPath);
    if (entry is null)
    {
        Console.Error.WriteLine($"entry not found: {internalPath}");
        return 1;
    }

    package.ReadEntry(entry, out var output);
    var outDir = Path.GetDirectoryName(outFile);
    if (!string.IsNullOrEmpty(outDir))
        Directory.CreateDirectory(outDir);
    File.WriteAllBytes(outFile, output);
    Console.WriteLine($"extracted {internalPath} ({output.Length} bytes) -> {outFile}");
    return 0;
}

// decode <vpk> <internalVsndC> <outBaseNoExt>   (extract from a vpk, then decode)
// decode <vsnd_c file> <outBaseNoExt>           (decode a loose .vsnd_c)
// Decodes a compiled Source 2 sound to playable audio (wav/mp3/aac). Prints the
// written file path (with the correct extension) to stdout.
static int Decode(string[] args)
{
    byte[] bytes;
    string outBase;
    if (args.Length >= 4)
    {
        var vpk = Path.GetFullPath(args[1]);
        var internalPath = args[2].Replace('\\', '/').TrimStart('/');
        outBase = Path.GetFullPath(args[3]);
        using var package = new Package();
        package.Read(vpk);
        var entry = package.FindEntry(internalPath) ?? FindFuzzy(package, internalPath);
        if (entry is null)
        {
            Console.Error.WriteLine($"entry not found: {internalPath}");
            return 1;
        }
        package.ReadEntry(entry, out bytes);
    }
    else if (args.Length == 3)
    {
        bytes = File.ReadAllBytes(Path.GetFullPath(args[1]));
        outBase = Path.GetFullPath(args[2]);
    }
    else
    {
        Console.Error.WriteLine(
            "usage: decode <vpk> <internalVsndC> <outBaseNoExt> | decode <vsnd_c> <outBaseNoExt>");
        return 2;
    }

    using var resource = new Resource();
    resource.Read(new MemoryStream(bytes));
    if (resource.DataBlock is not Sound sound)
    {
        Console.Error.WriteLine("not a sound resource");
        return 1;
    }

    var ext = sound.SoundType switch
    {
        Sound.AudioFileType.MP3 => "mp3",
        Sound.AudioFileType.AAC => "aac",
        _ => "wav",
    };
    var outPath = outBase + "." + ext;
    var dir = Path.GetDirectoryName(outPath);
    if (!string.IsNullOrEmpty(dir))
        Directory.CreateDirectory(dir);

    using (var s = sound.GetSoundStream())
    using (var fs = File.Create(outPath))
        s.CopyTo(fs);

    Console.WriteLine(outPath);
    return 0;
}

// decompile <vpk> <internalPath> <outFile>   (from a vpk)
// decompile <vsndevts_c file> <outFile>       (loose file)
// Decompiles a compiled Source 2 resource (e.g. .vsndevts_c) back to its KV3
// text source, so we can read what another mod added.
static int Decompile(string[] args)
{
    byte[] bytes;
    string outFile;
    if (args.Length >= 4)
    {
        var vpk = Path.GetFullPath(args[1]);
        var internalPath = args[2].Replace('\\', '/').TrimStart('/');
        outFile = Path.GetFullPath(args[3]);
        using var package = new Package();
        package.Read(vpk);
        var entry = package.FindEntry(internalPath) ?? FindFuzzy(package, internalPath);
        if (entry is null)
        {
            Console.Error.WriteLine($"entry not found: {internalPath}");
            return 1;
        }
        package.ReadEntry(entry, out bytes);
    }
    else if (args.Length == 3)
    {
        bytes = File.ReadAllBytes(Path.GetFullPath(args[1]));
        outFile = Path.GetFullPath(args[2]);
    }
    else
    {
        Console.Error.WriteLine(
            "usage: decompile <vpk> <internalPath> <outFile> | decompile <file_c> <outFile>");
        return 2;
    }

    using var resource = new Resource();
    resource.Read(new MemoryStream(bytes));
    using var content = FileExtract.Extract(resource, null, null);
    var dir = Path.GetDirectoryName(outFile);
    if (!string.IsNullOrEmpty(dir))
        Directory.CreateDirectory(dir);
    File.WriteAllBytes(outFile, content.Data);
    Console.WriteLine(outFile);
    return 0;
}

// texture <vpk> <internalVtexC> <outPng>   (from a vpk)
// texture <vtex_c file> <outPng>            (loose file)
// Decodes a compiled Source 2 texture (.vtex_c) to a PNG.
static int TextureCmd(string[] args)
{
    byte[] bytes;
    string outFile;
    if (args.Length >= 4)
    {
        var vpk = Path.GetFullPath(args[1]);
        var internalPath = args[2].Replace('\\', '/').TrimStart('/');
        outFile = Path.GetFullPath(args[3]);
        using var package = new Package();
        package.Read(vpk);
        var entry = package.FindEntry(internalPath);
        if (entry is null)
        {
            Console.Error.WriteLine($"entry not found: {internalPath}");
            return 1;
        }
        package.ReadEntry(entry, out bytes);
    }
    else if (args.Length == 3)
    {
        bytes = File.ReadAllBytes(Path.GetFullPath(args[1]));
        outFile = Path.GetFullPath(args[2]);
    }
    else
    {
        Console.Error.WriteLine(
            "usage: texture <vpk> <internalVtexC> <outPng> | texture <vtex_c> <outPng>");
        return 2;
    }

    using var resource = new Resource();
    resource.Read(new MemoryStream(bytes));
    if (resource.DataBlock is not Texture texture)
    {
        Console.Error.WriteLine("not a texture resource");
        return 1;
    }
    WritePng(texture, outFile);
    Console.WriteLine(outFile);
    return 0;
}

// texturebatch <vpk> <destDir> <internalVtexC>...
// Decodes several textures from one vpk in a single Package.Read, each to
// <destDir>/<stem>.png (stem = the vtex_c basename without extension). Prints
// "stem\tpath" per decoded texture; missing/non-texture entries are skipped.
static int TextureBatch(string[] args)
{
    if (args.Length < 4)
    {
        Console.Error.WriteLine("usage: texturebatch <vpk> <destDir> <internalVtexC>...");
        return 2;
    }
    var vpk = Path.GetFullPath(args[1]);
    var destDir = Path.GetFullPath(args[2]);
    Directory.CreateDirectory(destDir);

    using var package = new Package();
    package.Read(vpk);

    for (var i = 3; i < args.Length; i++)
    {
        var internalPath = args[i].Replace('\\', '/').TrimStart('/');
        var entry = package.FindEntry(internalPath);
        if (entry is null)
        {
            Console.Error.WriteLine($"entry not found: {internalPath}");
            continue;
        }
        try
        {
            package.ReadEntry(entry, out var bytes);
            using var resource = new Resource();
            resource.Read(new MemoryStream(bytes));
            if (resource.DataBlock is not Texture tex)
            {
                Console.Error.WriteLine($"not a texture: {internalPath}");
                continue;
            }
            var stem = Path.GetFileNameWithoutExtension(internalPath);
            var outPath = Path.Combine(destDir, stem + ".png");
            WritePng(tex, outPath);
            Console.WriteLine(stem + "\t" + outPath);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"skip {internalPath}: {ex.Message}");
        }
    }
    return 0;
}

// heroes <vpk> <destDir>
// Batch-decodes each hero's card portrait under panorama/images/heroes/ to
// <destDir>/<codename>.png in a single pass (one Package.Read). Prefers the
// "_card_psd" art, falling back to _vertical/_sm/_mm. Prints "codename\tpath"
// per hero. Variant tags (_critical/_gloat/hashed) are ignored.
static int Heroes(string[] args)
{
    if (args.Length < 3)
    {
        Console.Error.WriteLine("usage: heroes <vpk> <destDir>");
        return 2;
    }
    var vpk = Path.GetFullPath(args[1]);
    var destDir = Path.GetFullPath(args[2]);
    Directory.CreateDirectory(destDir);

    using var package = new Package();
    package.Read(vpk);

    const string dirPrefix = "panorama/images/heroes/";
    // Lower rank = preferred.
    string[] suffixes = { "_card_psd", "_vertical_psd", "_sm_psd", "_mm_psd" };
    const string gloatSuffix = "_card_gloat_psd";
    var best = new Dictionary<string, (int rank, PackageEntry entry)>();
    var gloat = new Dictionary<string, PackageEntry>();

    foreach (var byExt in package.Entries)
    {
        foreach (var e in byExt.Value)
        {
            var full = e.GetFullPath();
            if (!full.StartsWith(dirPrefix, StringComparison.OrdinalIgnoreCase)) continue;
            if (!full.EndsWith(".vtex_c", StringComparison.OrdinalIgnoreCase)) continue;
            var name = full.Substring(dirPrefix.Length);
            if (name.Contains('/')) continue; // skip nested folders
            name = name[..^".vtex_c".Length];

            // The "gloat" card variant — decoded to <code>_gloat.png for the
            // hover effect. Collected separately from the primary card.
            if (name.EndsWith(gloatSuffix, StringComparison.OrdinalIgnoreCase))
            {
                gloat[name[..^gloatSuffix.Length]] = e;
                continue;
            }

            int rank = -1;
            string? code = null;
            for (int i = 0; i < suffixes.Length; i++)
            {
                if (name.EndsWith(suffixes[i], StringComparison.OrdinalIgnoreCase))
                {
                    code = name[..^suffixes[i].Length];
                    rank = i;
                    break;
                }
            }
            // No recognized suffix (e.g. hashed/critical variants) -> skip.
            if (code is null || code.Length == 0) continue;
            if (code.Contains("_card", StringComparison.OrdinalIgnoreCase)) continue;

            if (!best.TryGetValue(code, out var cur) || rank < cur.rank)
                best[code] = (rank, e);
        }
    }

    foreach (var kv in best.OrderBy(k => k.Key, StringComparer.Ordinal))
    {
        try
        {
            package.ReadEntry(kv.Value.entry, out var bytes);
            using var resource = new Resource();
            resource.Read(new MemoryStream(bytes));
            if (resource.DataBlock is not Texture tex) continue;
            var outPath = Path.Combine(destDir, kv.Key + ".png");
            WritePng(tex, outPath);
            Console.WriteLine(kv.Key + "\t" + outPath);

            // Decode the matching gloat card, if any.
            if (gloat.TryGetValue(kv.Key, out var ge))
            {
                try
                {
                    package.ReadEntry(ge, out var gbytes);
                    using var gres = new Resource();
                    gres.Read(new MemoryStream(gbytes));
                    if (gres.DataBlock is Texture gtex)
                        WritePng(gtex, Path.Combine(destDir, kv.Key + "_gloat.png"));
                }
                catch (Exception gex)
                {
                    Console.Error.WriteLine($"skip gloat {kv.Key}: {gex.Message}");
                }
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"skip {kv.Key}: {ex.Message}");
        }
    }
    return 0;
}

// Decode a Texture to a PNG file (creating parent dirs).
static void WritePng(Texture texture, string outFile)
{
    using var bitmap = texture.GenerateBitmap();
    var dir = Path.GetDirectoryName(outFile);
    if (!string.IsNullOrEmpty(dir))
        Directory.CreateDirectory(dir);
    using var image = SKImage.FromBitmap(bitmap);
    using var data = image.Encode(SKEncodedImageFormat.Png, 100);
    using var fs = File.Create(outFile);
    data.SaveTo(fs);
}

// Fallback lookup for when an exact .vsnd_c path isn't found: match by stem
// prefix. Handles version drift where a track gained a suffix (e.g. the events
// file references `music_idol_carry_lp.vsnd` but the pak has
// `music_idol_carry_lp_141bpm.vsnd_c`).
static PackageEntry? FindFuzzy(Package package, string internalPath)
{
    var noExt = internalPath.EndsWith(".vsnd_c", StringComparison.OrdinalIgnoreCase)
        ? internalPath[..^7]
        : internalPath;
    // Guard against a near-empty prefix matching (and returning) an arbitrary
    // short sound — that surfaces as a misleading "beep" preview.
    if (noExt.Trim('/').Length < 4)
        return null;
    PackageEntry? best = null;
    foreach (var byExt in package.Entries)
    {
        foreach (var e in byExt.Value)
        {
            var full = e.GetFullPath();
            if (full.EndsWith(".vsnd_c", StringComparison.OrdinalIgnoreCase) &&
                full.StartsWith(noExt, StringComparison.OrdinalIgnoreCase))
            {
                // Prefer the shortest match (closest to the requested stem).
                if (best is null || full.Length < best.GetFullPath().Length)
                    best = e;
            }
        }
    }
    return best;
}

// extractall <vpk> <destDir> [pathPrefix]
// Extracts every file (optionally only those under pathPrefix) into destDir,
// preserving the content-relative folder layout. Prints the count.
// decompileall <vpk> <destDir> [pathPrefix]
// Decompile EVERYTHING in a vpk into source form, preserving the folder
// structure: sounds → mp3/wav/aac, textures → png, other compiled resources →
// decompiled text (KV3 etc.); anything that can't be decompiled is copied raw.
static int DecompileAll(string[] args)
{
    if (args.Length < 3)
    {
        Console.Error.WriteLine("usage: decompileall <vpk> <destDir> [pathPrefix]");
        return 2;
    }
    var vpk = Path.GetFullPath(args[1]);
    var destDir = Path.GetFullPath(args[2]);
    var prefix = args.Length >= 4 ? args[3].Replace('\\', '/').TrimStart('/') : "";

    using var package = new Package();
    package.Read(vpk);
    int decompiled = 0, raw = 0, fellBack = 0;

    string Prepare(string rel)
    {
        var dest = Path.Combine(destDir, rel.Replace('/', Path.DirectorySeparatorChar));
        var dir = Path.GetDirectoryName(dest);
        if (!string.IsNullOrEmpty(dir))
            Directory.CreateDirectory(dir);
        return dest;
    }

    foreach (var byExt in package.Entries)
    {
        foreach (var entry in byExt.Value)
        {
            var full = entry.GetFullPath();
            if (prefix.Length > 0 && !full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                continue;
            package.ReadEntry(entry, out var bytes);

            if (full.EndsWith("_c", StringComparison.OrdinalIgnoreCase))
            {
                try
                {
                    using var resource = new Resource();
                    resource.Read(new MemoryStream(bytes));
                    var noC = full[..^2]; // drop the trailing "_c"
                    if (resource.DataBlock is Sound snd)
                    {
                        var ext = snd.SoundType switch
                        {
                            Sound.AudioFileType.MP3 => "mp3",
                            Sound.AudioFileType.AAC => "aac",
                            _ => "wav",
                        };
                        var dest = Prepare(Path.ChangeExtension(noC, ext));
                        using var s = snd.GetSoundStream();
                        using var fs = File.Create(dest);
                        s.CopyTo(fs);
                    }
                    else if (resource.DataBlock is Texture tex)
                    {
                        WritePng(tex, Prepare(Path.ChangeExtension(noC, "png")));
                    }
                    else
                    {
                        using var content = FileExtract.Extract(resource, null, null);
                        File.WriteAllBytes(Prepare(noC), content.Data);
                    }
                    decompiled++;
                    continue;
                }
                catch
                {
                    fellBack++; // fall through to a raw copy
                }
            }
            File.WriteAllBytes(Prepare(full), bytes);
            raw++;
        }
    }
    Console.WriteLine($"decompiled {decompiled}, copied {raw} raw ({fellBack} fell back) -> {destDir}");
    return 0;
}

static int ExtractAll(string[] args)
{
    if (args.Length < 3)
    {
        Console.Error.WriteLine("usage: extractall <vpk> <destDir> [pathPrefix]");
        return 2;
    }
    var vpk = Path.GetFullPath(args[1]);
    var destDir = Path.GetFullPath(args[2]);
    var prefix = args.Length >= 4 ? args[3].Replace('\\', '/').TrimStart('/') : "";

    using var package = new Package();
    package.Read(vpk);
    var count = 0;
    foreach (var byExt in package.Entries)
    {
        foreach (var entry in byExt.Value)
        {
            var full = entry.GetFullPath();
            if (prefix.Length > 0 && !full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                continue;
            package.ReadEntry(entry, out var bytes);
            var dest = Path.Combine(destDir, full.Replace('/', Path.DirectorySeparatorChar));
            var dir = Path.GetDirectoryName(dest);
            if (!string.IsNullOrEmpty(dir))
                Directory.CreateDirectory(dir);
            File.WriteAllBytes(dest, bytes);
            count++;
        }
    }
    Console.WriteLine($"extracted {count} files -> {destDir}");
    return 0;
}

// list <vpk> [substring]
// crcs <vpk> [substring]
// Dump each entry's CRC32 (from the vpk index — no data is read) as
// "crc32hex<TAB>path", one per line. Used to detect pack files that are
// byte-identical to the game's originals.
static int Crcs(string[] args)
{
    if (args.Length < 2)
    {
        Console.Error.WriteLine("usage: crcs <vpk> [substring]");
        return 2;
    }
    var vpk = Path.GetFullPath(args[1]);
    string? filter = args.Length >= 3 ? args[2] : null;

    using var package = new Package();
    package.Read(vpk);

    var sb = new System.Text.StringBuilder();
    foreach (var byExt in package.Entries)
    {
        foreach (var entry in byExt.Value)
        {
            var full = entry.GetFullPath();
            if (filter is null || full.Contains(filter, StringComparison.OrdinalIgnoreCase))
                sb.Append(entry.CRC32.ToString("x8")).Append('\t').Append(full).Append('\n');
        }
    }
    Console.Out.Write(sb.ToString());
    return 0;
}

static int List(string[] args)
{
    if (args.Length < 2)
    {
        Console.Error.WriteLine("usage: list <vpk> [substring]");
        return 2;
    }
    var vpk = Path.GetFullPath(args[1]);
    string? filter = args.Length >= 3 ? args[2] : null;

    using var package = new Package();
    package.Read(vpk);

    foreach (var byExt in package.Entries)
    {
        foreach (var entry in byExt.Value)
        {
            var full = entry.GetFullPath();
            if (filter is null || full.Contains(filter, StringComparison.OrdinalIgnoreCase))
                Console.WriteLine(full);
        }
    }
    return 0;
}
