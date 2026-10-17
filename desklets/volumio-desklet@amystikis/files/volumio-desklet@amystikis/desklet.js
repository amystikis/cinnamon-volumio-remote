const Gettext = imports.gettext;
const GLib = imports.gi.GLib;
const UUID = "volumio-desklet@amystikis";

Gettext.bindtextdomain(UUID, GLib.get_user_data_dir() + "/locale");

function _(str) {
    let translated = Gettext.dgettext(UUID, str);
    return translated !== str ? translated : Gettext.gettext(str);
}

const Desklet = imports.ui.desklet;
const Settings = imports.ui.settings;
const Mainloop = imports.mainloop;
const Util = imports.misc.util;
const St = imports.gi.St;
const Gio = imports.gi.Gio;
const Gdk = imports.gi.Gdk;
const Pango = imports.gi.Pango;
const Clutter = imports.gi.Clutter;

const PAD = 12;

// ---------- artwork lookup: MusicBrainz + Cover Art Archive (open), iTunes (optional) ----------
const ART_UA = "VolumioRemoteCinnamon/1.0 (https://github.com/amystikis)";

function artNorm(x) {
    return (x || "").toLowerCase().replace(/\(.*?\)|\[.*?\]/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

// Possible (artist, song) readings of the playing text. Web radio often sends "Artist - Song" as the title.
function artCandidates(artist, title, badArtist) {
    if (!badArtist) return [{ artist: artist, song: title }];
    let parts = title.split(/\s+[-\u2013\u2014]\s+/);
    let out = [];
    if (parts.length < 2) return out;
    let n = parts.length;
    let add = (a, s) => { if (a && s && !out.some(o => o.artist === a && o.song === s)) out.push({ artist: a, song: s }); };
    add(parts[0], parts.slice(1).join(" - "));
    if (n > 2) {
        add(parts[n - 2], parts[n - 1]);
        add(parts.slice(0, n - 1).join(" - "), parts[n - 1]);
    }
    return out.slice(0, 3);
}

// Returns the first cover-art-archive URL (of up to 5 release groups) that really has a front cover.
function artFirstCover(ids, alive, cb) {
    if (!ids.length || !alive()) { cb(""); return; }
    let url = "https://coverartarchive.org/release-group/" + ids[0] + "/front-500";
    Util.spawn_async(["curl", "-s", "-m", "8", "-L", "-r", "0-0", "-A", ART_UA, "-o", "/dev/null", "-w", "%{http_code}", url], (out) => {
        if (!alive()) return;
        if (/^20[06]/.test((out || "").trim())) cb(url); else artFirstCover(ids.slice(1), alive, cb);
    });
}

function artMusicBrainz(cands, alive, cb) {
    let i = 0;
    let next = () => {
        if (!alive()) return;
        if (i >= cands.length) { cb(""); return; }
        let c = cands[i++];
        let q = 'artist:"' + c.artist.replace(/["\\]/g, " ") + '" AND recording:"' + c.song.replace(/["\\]/g, " ") + '"';
        Util.spawn_async(["curl", "-s", "-m", "8", "-A", ART_UA, "-G", "https://musicbrainz.org/ws/2/recording",
                          "--data-urlencode", "query=" + q, "--data-urlencode", "fmt=json", "--data-urlencode", "limit=25"], (out) => {
            if (!alive()) return;
            let groups = [];
            try {
                let nA = artNorm(c.artist), nS = artNorm(c.song);
                for (let r of JSON.parse(out).recordings || []) {
                    if (r.score < 85) continue;
                    let credit = r["artist-credit"] && r["artist-credit"][0];
                    let rt = artNorm(r.title), ra = artNorm(credit && credit.name);
                    if (!rt || !ra) continue;
                    if (!(rt === nS || nS.indexOf(rt + " ") === 0 || rt.indexOf(nS + " ") === 0)) continue;
                    if (nA.indexOf(ra) < 0 && ra.indexOf(nA) < 0) continue;
                    for (let rel of r.releases || []) {
                        let g = rel["release-group"];
                        if (!g) continue;
                        let sec = g["secondary-types"] || [];
                        let rank = (rel.status === "Official" ? 0 : 4) + (sec.length === 0 ? 0 : (sec.length === 1 && sec[0] === "Compilation" ? 1 : 2));
                        groups.push({ id: g.id, rank: rank });
                    }
                }
            } catch (e) {}
            groups.sort((a, b) => a.rank - b.rank);
            let ids = [];
            groups.forEach(g => { if (ids.indexOf(g.id) < 0) ids.push(g.id); });
            artFirstCover(ids.slice(0, 5), alive, (url) => {
                if (url) cb(url);
                else Mainloop.timeout_add(1100, () => { next(); return false; });   // MusicBrainz allows 1 request/second
            });
        });
    };
    next();
}

function artItunes(term, alive, cb) {
    let nterm = " " + artNorm(term) + " ";
    Util.spawn_async(["curl", "-s", "-m", "6", "-G", "--data-urlencode", "term=" + term,
                      "https://itunes.apple.com/search?entity=song&limit=10"], (out) => {
        if (!alive()) return;
        let url = "";
        try {
            // accept a result only if both its song name and its artist appear in the track text
            for (let r of JSON.parse(out).results) {
                let track = artNorm(r.trackName);
                let who = artNorm(String(r.artistName).split(/,|&| feat\.? /i)[0]);
                if (track && who && nterm.indexOf(" " + track + " ") >= 0 && nterm.indexOf(" " + who + " ") >= 0 && r.artworkUrl100) {
                    url = r.artworkUrl100.replace("100x100", "600x600");
                    break;
                }
            }
        } catch (e) {}
        cb(url);
    });
}

class VolumioDesklet extends Desklet.Desklet {
    constructor(metadata, deskletId) {
        super(metadata, deskletId);
        this.state = null;
        this.vol = 0;
        this.muted = false;
        this.artUrl = "";
        this.artN = 0;
        this.holdUntil = 0;
        this.cacheDir = GLib.get_user_cache_dir() + "/volumio-desklet-" + deskletId;
        GLib.mkdir_with_parents(this.cacheDir, 0o755);

        this.settings = new Settings.DeskletSettings(this, metadata.uuid, deskletId);
        let ui = () => this.buildUI();
        this.settings.bind("host", "host", () => { this.lookupTerm = null; this.poll(); });
        this.settings.bind("interval", "interval");
        this.settings.bind("art-source", "artSource", () => { this.lookupTerm = null; this.render(); });
        for (let k of ["layout", "width", "height", "corner-radius", "art-shape", "show-art", "bg-color", "bg-opacity", "text-color"]) {
            this.settings.bind(k, k.replace(/-(\w)/g, (m, c) => c.toUpperCase()), ui);
        }

        this.buildUI();
        this.poll();
        this.marqueeTimer = Mainloop.timeout_add(33, () => this.tickMarquees());
    }

    rgba(str, alpha) {
        let c = new Gdk.RGBA();
        if (!c.parse(str)) return "rgba(30,30,30," + alpha + ")";
        return "rgba(" + Math.round(c.red * 255) + "," + Math.round(c.green * 255) + "," + Math.round(c.blue * 255) + "," + alpha + ")";
    }

    iconButton(icon, size, onclick) {
        let b = new St.Button({ reactive: true, track_hover: true,
            style: "padding: 3px 7px; border-radius: 12px; background-color: rgba(255,255,255,0.14);" });
        b.set_child(new St.Icon({ icon_name: icon, icon_type: St.IconType.SYMBOLIC, icon_size: size,
            style: "color: " + this.textColor + ";" }));
        b.connect("clicked", onclick);
        return b;
    }

    buildUI() {
        let horizontal = this.layout === "horizontal";
        let w = this.width;
        let card = new St.BoxLayout({ vertical: !horizontal, reactive: true,
            style: "padding: " + PAD + "px; spacing: 12px; border-radius: " + this.cornerRadius + "px; " +
                   "background-color: " + this.rgba(this.bgColor, this.bgOpacity / 100) + "; color: " + this.textColor + ";" });
        card.set_width(w);
        if (horizontal) card.set_height(this.height);

        // art
        this.art = null;
        if (this.showArt) {
            let size = horizontal ? this.height - 2 * PAD : w - 2 * PAD;
            this.artSize = size;
            this.art = new St.Bin({ width: size, height: size, x_align: St.Align.MIDDLE, y_align: St.Align.MIDDLE });
            this.artIcon = new St.Icon({ icon_name: "audio-x-generic-symbolic", icon_type: St.IconType.SYMBOLIC,
                icon_size: Math.max(24, Math.round(size / 3)), style: "color: " + this.textColor + ";" });
            this.artFile = null;
            this.applyArtStyle();
            card.add_actor(this.art);
        }

        // text + controls column
        let col = new St.BoxLayout({ vertical: true, x_expand: true, y_expand: true, style: "spacing: 3px;" });
        col.set_y_align(St.Align.MIDDLE);

        let colW = horizontal && this.showArt ? w - 2 * PAD - this.artSize - 12 : w - 2 * PAD;
        col.set_width(colW);
        this.marquees = [];
        this.stationLbl = this.makeMarquee(col, colW, "font-size: 8pt; font-weight: bold; color: #8ab4f8;", 15);
        this.stationLbl.box.hide();
        this.titleLbl = this.makeMarquee(col, colW, "font-weight: bold; font-size: 13pt;", 26);
        this.artistLbl = this.makeMarquee(col, colW, "font-size: 10pt;", 20);

        // volume row: mute, -, bar, +, percent
        let vrow = new St.BoxLayout({ style: "spacing: 6px; padding-top: 6px;" });
        this.muteBtn = this.iconButton("audio-volume-medium-symbolic", 14, () => this.toggleMute());
        vrow.add_actor(this.muteBtn);
        vrow.add_actor(this.iconButton("list-remove-symbolic", 14, () => this.setVolume(this.vol - 5)));

        this.track = new St.BoxLayout({ reactive: true, x_expand: true, y_align: St.Align.MIDDLE,
            height: 8, style: "background-color: rgba(255,255,255,0.22); border-radius: 4px;" });
        this.fill = new St.Widget({ height: 8, width: 0, style: "background-color: #8ab4f8; border-radius: 4px;" });
        this.track.add_actor(this.fill);
        this.track.connect("button-press-event", (a, ev) => { this.barClick(ev); return true; });
        this.track.connect("notify::width", () => this.updateVolUI());
        vrow.add(this.track, { expand: true, y_fill: false });

        vrow.add_actor(this.iconButton("list-add-symbolic", 14, () => this.setVolume(this.vol + 5)));
        this.volLbl = new St.Label({ text: "--", y_align: St.Align.MIDDLE, style: "min-width: 34px; font-size: 10pt;" });
        vrow.add_actor(this.volLbl);
        col.add_actor(vrow);

        card.add_actor(col);

        card.connect("scroll-event", (a, ev) => {
            this.setVolume(this.vol + (ev.get_scroll_direction() === 0 ? 3 : -3));
            return true;
        });

        this.setContent(card);
        this.render();
    }

    // A label inside a clipped box that slides sideways when the text is wider than the space.
    makeMarquee(parent, width, style, height) {
        let box = new St.Widget({ layout_manager: new Clutter.FixedLayout(), clip_to_allocation: true, width: width, height: height });
        let label = new St.Label({ text: "", style: "color: " + this.textColor + "; " + style });
        label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
        box.add_child(label);
        label.set_position(0, 0);
        parent.add_actor(box);
        let m = { box: box, label: label, width: width, text: "", pos: 0, wait: 0, dir: 1 };
        m.set_text = (t) => {
            if (t === m.text) return;
            m.text = t;
            label.set_text(t);
            m.pos = 0; m.wait = 45; m.dir = 1;
            label.set_position(0, 0);
        };
        this.marquees.push(m);
        return m;
    }

    tickMarquees() {
        for (let m of this.marquees) {
            let max = m.label.get_preferred_width(-1)[1] - m.width;
            if (max <= 1) { if (m.pos !== 0) { m.pos = 0; m.label.set_position(0, 0); } continue; }
            if (m.wait > 0) { m.wait--; continue; }
            m.pos += m.dir * 1.5;
            if (m.pos >= max) { m.pos = max; m.dir = -1; m.wait = 45; }
            else if (m.pos <= 0) { m.pos = 0; m.dir = 1; m.wait = 45; }
            m.label.set_position(Math.round(-m.pos), 0);
        }
        return true;
    }

    applyArtStyle() {
        if (!this.art) return;
        let r = this.artShape === "circle" ? Math.round(this.artSize / 2) : (this.artShape === "rounded" ? 12 : 0);
        let bg = this.artFile
            ? "background-image: url('" + this.artFile + "'); background-size: cover;"
            : "background-color: rgba(255,255,255,0.10);";
        this.art.set_style("border-radius: " + r + "px; " + bg);
        this.art.set_child(this.artFile ? null : this.artIcon);
    }

    // ---- network ----
    url(path) { return "http://" + this.host + path; }

    send(c) {
        Util.spawn_async(["curl", "-s", "-m", "3", this.url("/api/v1/commands/?cmd=" + c)], () => {});
    }

    setVolume(v) {
        v = Math.max(0, Math.min(100, Math.round(v)));
        this.vol = v;
        this.holdUntil = Date.now() + 1500;
        this.updateVolUI();
        if (this.volTimer) Mainloop.source_remove(this.volTimer);
        this.volTimer = Mainloop.timeout_add(150, () => {
            this.volTimer = null;
            this.send("volume&volume=" + v);
            return false;
        });
    }

    toggleMute() {
        this.muted = !this.muted;
        this.holdUntil = Date.now() + 1500;
        this.updateVolUI();
        this.send("volume&volume=" + (this.muted ? "mute" : "unmute"));
    }

    barClick(ev) {
        try {
            let [x, y] = ev.get_coords();
            let [ok, lx] = this.track.transform_stage_point(x, y);
            let w = this.track.get_width();
            if (ok && w > 0) this.setVolume(lx / w * 100);
        } catch (e) { global.logError("volumio desklet: " + e); }
    }

    updateVolUI() {
        if (!this.fill) return;
        let w = this.track.get_width();
        this.fill.set_width(Math.round(w * (this.muted ? 0 : this.vol) / 100));
        this.volLbl.set_text(this.muted ? "mute" : this.vol + "%");
        this.muteBtn.get_child().icon_name = this.muted ? "audio-volume-muted-symbolic" : "audio-volume-medium-symbolic";
    }

    poll() {
        if (this.destroyed) return;
        if (this.pollTimer) { Mainloop.source_remove(this.pollTimer); this.pollTimer = null; }
        Util.spawn_async(["curl", "-s", "-m", "3", this.url("/api/v1/getState")], (out) => {
            try { this.state = JSON.parse(out); } catch (e) { this.state = null; }
            this.render();
        });
        this.pollTimer = Mainloop.timeout_add_seconds(this.interval, () => { this.pollTimer = null; this.poll(); return false; });
    }

    // ---- station name (web radio): not in getState, so read it from the queue ----
    setStation(name) {
        let m = this.stationLbl;
        if (!m) return;
        m.set_text(name ? "\u{1F4FB}  " + name.toUpperCase() : "");
        if (name) m.box.show(); else m.box.hide();
    }

    updateStation(s) {
        if (s.service !== "webradio") { this.stationUri = null; this.setStation(""); return; }
        if (s.uri === this.stationUri) return;
        this.stationUri = s.uri;
        this.setStation("");
        Util.spawn_async(["curl", "-s", "-m", "3", this.url("/api/v1/getQueue")], (out) => {
            if (this.destroyed || s.uri !== this.stationUri) return;
            try {
                let q = JSON.parse(out).queue || [];
                let it = q.find(i => i.uri === s.uri);
                if (it) this.setStation(it.name || it.title || "");
            } catch (e) { this.stationUri = null; }
        });
    }

    // ---- art ----
    resolveArt(s) {
        let a = s.albumart || "";
        let real = a && a !== "/albumart" && !(s.service === "webradio" && a.indexOf("/albumart") === 0);
        if (real) { this.lookupTerm = null; this.updateArt(a); return; }
        let title = (s.title || "").trim();
        let artist = (s.artist || "").trim();
        let badArtist = !artist || /^(no ?name|net ?cast|unknown|null|undefined|n\/a)$/i.test(artist);
        // Volumio builds its own cover from the artist; for "no name" that is a wrong picture, so never use it.
        let fallback = badArtist ? "" : a;
        if (!title || s.status === "stop") { this.lookupTerm = null; this.updateArt(fallback); return; }
        let term = badArtist ? title : artist + " " + title;
        if (term === this.lookupTerm) return;
        this.lookupTerm = term;
        let src = this.artSource || "mb-itunes";
        let sources = src === "off" ? [] : src === "mb" ? ["mb"] : src === "itunes" ? ["itunes"] : ["mb", "itunes"];
        let alive = () => !this.destroyed && term === this.lookupTerm;
        let cands = artCandidates(artist, title, badArtist);
        let run = (k) => {
            if (!alive()) return;
            if (k >= sources.length) { this.updateArt(fallback); return; }
            let done = (url) => { if (!alive()) return; if (url) this.updateArt(url); else run(k + 1); };
            if (sources[k] === "mb") artMusicBrainz(cands, alive, done); else artItunes(term, alive, done);
        };
        run(0);
    }

    updateArt(path) {
        let url = !path ? "" : (path.indexOf("http") === 0 ? path : this.url(path));
        if (url === this.artUrl) return;
        this.artUrl = url;
        if (!url) { this.artFile = null; this.applyArtStyle(); return; }
        let file = this.cacheDir + "/art-" + Date.now() + "-" + (++this.artN);
        Util.spawn_async(["curl", "-s", "-m", "8", "-L", "-o", file, url], () => {
            if (this.destroyed || url !== this.artUrl) return;
            this.artFile = file;
            this.applyArtStyle();
            this.artFiles = (this.artFiles || []).concat(file);
            while (this.artFiles.length > 2) {
                try { Gio.File.new_for_path(this.artFiles.shift()).delete(null); } catch (e) {}
            }
        });
    }

    // ---- render ----
    render() {
        let s = this.state;
        if (!this.titleLbl) return;
        if (!s) {
            this.setStation("");
            this.titleLbl.set_text(_("Volumio unreachable"));
            this.artistLbl.set_text(this.host);
            return;
        }
        this.titleLbl.set_text(s.title || _("Nothing playing"));
        this.artistLbl.set_text(s.artist || "");
        if (Date.now() > this.holdUntil) {
            if (typeof s.volume === "number") this.vol = s.volume;
            this.muted = !!s.mute;
            this.updateVolUI();
        }
        this.updateStation(s);
        if (this.showArt) this.resolveArt(s);
    }

    on_desklet_removed() {
        this.destroyed = true;
        if (this.pollTimer) Mainloop.source_remove(this.pollTimer);
        if (this.marqueeTimer) Mainloop.source_remove(this.marqueeTimer);
        if (this.volTimer) Mainloop.source_remove(this.volTimer);
        this.settings.finalize();
        try { GLib.spawn_command_line_async("rm -rf '" + this.cacheDir + "'"); } catch (e) {}
    }
}

function main(metadata, deskletId) {
    return new VolumioDesklet(metadata, deskletId);
}
