import Resources from "./resources";
import { PlayerState } from "./spotify-apis";

interface PathVar
{
    name: string;
    desc: string;
    pattern: string;
    dontEscape?: boolean;
    getValue: (meta: any, playback: PlayerState) => string;
};

export type PathTemplateVars = Record<string, string>;

function createVarMap(vars: PathVar[])
{
    for (let entry of vars) {
        vars[entry.name] = entry;
    }
    return vars as PathVar[] & Record<string, PathVar>;
}

export class PathTemplate
{
    static readonly Vars = createVarMap([
        {
            name: "track_name",
            desc: "Track name / Episode name",
            pattern: `.+`,
            getValue: m => m.title
        },
        {
            name: "artist_name",
            desc: "Artist name / Publisher name",
            pattern: `.+`,
            getValue: m => m.album_artist
        },
        {
            name: "all_artist_names",
            desc: "Name of all artists featured in the track, separated by comma",
            pattern: `.+`,
            getValue: m => m.artist ? m.artist.replaceAll("/", ", ") : m.album_artist
        },
        {
            name: "album_name",
            desc: "Album name / Podcast name",
            pattern: `.+`,
            getValue: m => m.album
        },
        {
            name: "track_num",
            desc: "Album track number",
            pattern: `\\d+`,
            getValue: m => m.track
        },
        {
            name: "release_year",
            desc: "Release year",
            pattern: `\\d+`,
            getValue: m => m.date.split('-')[0]
        },
        {
            name: "release_date",
            desc: "Release date in YYYY-MM-DD format",
            pattern: `\\d+-\\d+-\\d+`,
            getValue: m => m.date
        },
        {
            name: "multi_disc_path",
            desc: "'/CD {disc number}' if the album has multiple discs, or empty.",
            pattern: `(\\/CD \\d+)?`,
            dontEscape: true,
            getValue: m => m.totaldiscs > 1 ? `/CD ${m.disc}` : ""
        },
        {
            name: "multi_disc_paren",
            desc: "' (CD {disc number})' if the album has multiple discs, or empty.",
            pattern: `( \\(CD \\d+\\))?`,
            getValue: m => m.totaldiscs > 1 ? ` (CD ${m.disc})` : ""
        },
        {
            name: "playlist_name",
            desc: "Playlist name or 'unknown' if the track playback didn't originate from a playlist.",
            pattern: `.+`,
            getValue: (m, s) => {
                let name = s.index.itemIndex != null && s.context.uri.startsWith("spotify:playlist:")
                            ? s.context.metadata.context_description : null;
                return name ?? "unknown";
            }
        },
        {
            name: "context_name",
            desc: "Context name or 'unknown' - Similar to {playlist_name}, but includes albums.",
            pattern: `.+`,
            getValue: (m, s) => {
                let name = s.index.itemIndex != null ? s.context.metadata.context_description : null;
                return name ?? "unknown";
            }
        }
    ]);

    static getVarsFromMetadata(meta: any, playback: PlayerState)
    {
        let vals: PathTemplateVars = {};
        for (let pv of PathTemplate.Vars) {
            vals[pv.name] = pv.getValue(meta, playback);
        }
        return vals;
    }
    /** Returns a object with metadata and variables for all tracks in the specified album or playlist. */
    static async getTracks(uri: string)
    {
        let type = Resources.getUriType(uri);

        if (type === "playlist") {
            let data = await Resources.getPlaylistTracks(uri, true);
            
            return {
                name: data.name,
                type: "playlist",
                tracks: data.tracks.items.map(track => ({
                    uri: track.uri,
                    durationMs: track.duration.milliseconds,
                    vars: {
                        track_name: track.name,
                        artist_name: track.artists[0].name,
                        all_artist_names: track.artists.map(v => v.name).join(", "),
                        album_name: track.album.name,
                        track_num: track.trackNumber,
                        playlist_name: data.name,
                        context_name: data.name
                    }
                }))
            };
        }
        if (type === "album") {
            let data = await Resources.getAlbumTracks(uri);
            
            return {
                name: data.name,
                type: "album",
                tracks: data.tracks.items.map(track => ({
                    uri: track.uri,
                    durationMs: track.duration_ms,
                    vars: {
                        track_name: track.name,
                        artist_name: track.artists[0].name,
                        all_artist_names: track.artists.map(v => v.name).join(", "),
                        album_name: data.name,
                        track_num: track.track_number,
                        playlist_name: "unknown",
                        context_name: data.name
                    }
                }))
            };
        }
        throw Error("Unknown URI type: " + type);
    }

    static render(template: string, vars: PathTemplateVars)
    {
        return template.replace(/{(.+?)}/g, (g0, g1) => {
            let val = vars[g1];
            if (val == null) {
                return g0;
            }
            if (!this.Vars[g1]?.dontEscape) {
                val = this.escapePath(val.toString());
            }
            return val;
        });
    }
    static escapePath(str: string)
    {
        const ReplacementChars = {
            '\\': '＼',
            '/': '／',
            ':': '：',
            '*': '＊',
            '?': '？',
            '"': '＂',
            '<': '＜',
            '>': '＞',
            '|': '￤',
        };
        //invalid characters -> similar characters
        str = str.replace(/[\x00-\x1f\/\\:*?"<>|]/g, v => ReplacementChars[v] ?? " ");
        //leading/trailling spaces -> "\u2002 En Space"
        str = str.replace(/(^ +| +$)/g, " ");
        //trailling dots -> "\uFF0E Fullwidth Stop"
        //also handles ".."
        str = str.replace(/\.+$/g, v => "．".repeat(v.length));

        return str;
    }
}

interface TemplateNode
{
    children: TemplateNode[];
    pattern: string;
    literal: boolean;
    id?: string;
}

const EXT_REGEX = /\.(mp3|m4a|mp4|ogg|opus)$/i;
    
export class TemplatedSearchTree
{
    root: TemplateNode = {
        children: [],
        pattern: "",
        literal: true
    };
    private _collator = new Intl.Collator(undefined, { sensitivity: "accent", usage: "search" });
    private _template: string[];
    
    constructor(template: string)
    {
        this._template = template.replace(EXT_REGEX, "{_ext}").split(/[\/\\]/);
    }

    add(id: string, vars: PathTemplateVars)
    {
        let node = this.root;
        for (let part of this._template) {
            let pattern = PathTemplate.render(part, vars);
            let literal = !/{(.+?)}/.test(pattern);
            if (!literal) { //placeholder is keept for unknown variables
                pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                pattern = pattern.replace(/\\{(.+?)\\}/g, (g0, g1) => {
                    if (g1 === "_ext") return EXT_REGEX.source;
                    return PathTemplate.Vars[g1]?.pattern ?? g0;
                });
            }
            node = this.findOrAddChild(node, pattern, literal);
        }
        if (node.id == null) {
            node.id = id;
        } else if (node.id !== id) {
            node.id += ",";
            node.id += id;
        }
    }
    
    private findOrAddChild(node: TemplateNode, pattern: string, isLiteral: boolean)
    {
        for (let child of node.children) {
            if (child.literal === isLiteral && this._collator.compare(child.pattern, pattern) === 0) {
                return child;
            }
        }
        let child = {
            children: [],
            pattern: pattern,
            literal: isLiteral
        };
        node.children.push(child);
        return child;
    }
}