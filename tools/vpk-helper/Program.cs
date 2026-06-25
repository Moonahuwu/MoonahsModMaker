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
using ValveResourceFormat.ResourceTypes;

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
            "decode" => Decode(args),
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

// Fallback lookup for when an exact .vsnd_c path isn't found: match by stem
// prefix. Handles version drift where a track gained a suffix (e.g. the events
// file references `music_idol_carry_lp.vsnd` but the pak has
// `music_idol_carry_lp_141bpm.vsnd_c`).
static PackageEntry? FindFuzzy(Package package, string internalPath)
{
    var noExt = internalPath.EndsWith(".vsnd_c", StringComparison.OrdinalIgnoreCase)
        ? internalPath[..^7]
        : internalPath;
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

// list <vpk> [substring]
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
