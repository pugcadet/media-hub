//! Audio fingerprints for finding the same intro or credits in several episodes.
//!
//! Method: the classic Haitsma–Kalker ("Philips") fingerprint. Audio is cut into short,
//! overlapping frames; for each frame the energy in 33 frequency bands is measured and
//! turned into 32 bits ("is the energy difference between neighbouring bands rising or
//! falling compared with the previous frame"). The same piece of music gives nearly the
//! same bits in every episode, even after re-encoding or a volume change.
//!
//! Matching: every time offset between two episodes is scored by how many frames line up
//! almost exactly; along the best offsets we look for the longest stretch where the bits
//! stay close (low bit error).
//! Pure code, unit tested with generated audio.

use std::collections::HashMap;

/// Sample rate the audio is decoded at (mono).
pub const RATE: u32 = 5512;
const FRAME: usize = 2048;
const STEP: usize = 128;
/// Fingerprint frames per second (~43).
pub const FPS: f32 = RATE as f32 / STEP as f32;
const BANDS: usize = 33;
/// Mean differing bits (out of 32) still counted as "the same audio".
const MAX_MEAN_BITS: f32 = 11.0;
/// Smoothing window for the bit error (about 1.5 seconds).
const WINDOW: usize = 64;
/// Short dips inside a match that are bridged (about 2 seconds).
const GAP: usize = 86;

/// Small in-place radix-2 FFT (n must be a power of two). `tw` holds e^(-2πik/n) for k < n/2.
fn fft(re: &mut [f32], im: &mut [f32], tw: &[(f32, f32)]) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let half = len / 2;
        let stride = n / len;
        for start in (0..n).step_by(len) {
            for k in 0..half {
                let (wr, wi) = tw[k * stride];
                let (a, b) = (start + k, start + k + half);
                let vr = re[b] * wr - im[b] * wi;
                let vi = re[b] * wi + im[b] * wr;
                re[b] = re[a] - vr;
                im[b] = im[a] - vi;
                re[a] += vr;
                im[a] += vi;
            }
        }
        len <<= 1;
    }
}

#[derive(Debug, Clone, Default)]
pub struct Fingerprint {
    pub bits: Vec<u32>,
    /// Frames that are (nearly) silent. Silence matches everything, so it never counts.
    pub quiet: Vec<bool>,
}

impl Fingerprint {
    pub fn len(&self) -> usize {
        self.bits.len()
    }
    pub fn is_empty(&self) -> bool {
        self.bits.is_empty()
    }
}

pub fn fingerprint(samples: &[i16]) -> Fingerprint {
    let mut out = Fingerprint::default();
    if samples.len() < FRAME + STEP {
        return out;
    }
    let tw: Vec<(f32, f32)> = (0..FRAME / 2)
        .map(|k| {
            let a = -2.0 * std::f64::consts::PI * k as f64 / FRAME as f64;
            (a.cos() as f32, a.sin() as f32)
        })
        .collect();
    let window: Vec<f32> = (0..FRAME)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (FRAME - 1) as f32).cos())
        .collect();
    // Band edges, log spaced from 300 Hz to 2000 Hz, as FFT bin numbers.
    let edges: Vec<usize> = (0..=BANDS)
        .map(|b| {
            let f = 300.0 * (2000.0f32 / 300.0).powf(b as f32 / BANDS as f32);
            (f * FRAME as f32 / RATE as f32).round() as usize
        })
        .collect();

    let mut re = vec![0f32; FRAME];
    let mut im = vec![0f32; FRAME];
    let mut prev: Option<[f32; BANDS]> = None;
    let mut pos = 0;
    while pos + FRAME <= samples.len() {
        let mut power = 0.0f64;
        for i in 0..FRAME {
            let s = samples[pos + i] as f32;
            power += (s * s) as f64;
            re[i] = s * window[i];
            im[i] = 0.0;
        }
        fft(&mut re, &mut im, &tw);
        let mut e = [0f32; BANDS];
        for b in 0..BANDS {
            e[b] = (edges[b]..edges[b + 1].max(edges[b] + 1)).map(|k| re[k] * re[k] + im[k] * im[k]).sum();
        }
        if let Some(p) = prev {
            let mut bits = 0u32;
            for m in 0..32 {
                if (e[m] - e[m + 1]) - (p[m] - p[m + 1]) > 0.0 {
                    bits |= 1 << m;
                }
            }
            let rms = (power / FRAME as f64).sqrt();
            out.bits.push(bits);
            out.quiet.push(rms < 60.0); // about -55 dBFS
        }
        prev = Some(e);
        pos += STEP;
    }
    out
}

/// A stretch of audio found in both fingerprints (seconds from each fingerprint's start).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Common {
    pub a_start: f32,
    pub a_end: f32,
    pub b_start: f32,
    pub b_end: f32,
    /// Mean differing bits per frame over the stretch (0 = identical, ~16 = unrelated).
    pub mean_bits: f32,
}

impl Common {
    pub fn len(&self) -> f32 {
        self.a_end - self.a_start
    }
}

/// Ranks time offsets by how many frames line up almost exactly (at most 8 of 32 bits
/// differ; for unrelated audio that happens for about 1 frame in 300). Every offset is
/// tried, which stays fast because comparing two frames is a single XOR + bit count.
fn top_offsets(a: &Fingerprint, b: &Fingerprint, n: usize) -> Vec<i64> {
    let (la, lb) = (a.len() as i64, b.len() as i64);
    let mut scores: HashMap<i64, u32> = HashMap::new();
    for d in -(lb - 1)..la {
        let (i0, i1) = (d.max(0), la.min(lb + d));
        if i1 - i0 < WINDOW as i64 {
            continue;
        }
        let mut good = 0u32;
        let mut i = i0;
        while i < i1 {
            let (iu, ju) = (i as usize, (i - d) as usize);
            if !a.quiet[iu] && !b.quiet[ju] && (a.bits[iu] ^ b.bits[ju]).count_ones() <= 8 {
                good += 1;
            }
            i += 2; // every other frame is plenty for ranking
        }
        if good > 0 {
            scores.insert(d, good);
        }
    }
    // Neighbouring offsets belong together (frames can be slightly out of step).
    let mut merged: Vec<(i64, u32)> = scores
        .keys()
        .map(|&d| (d, (d - 2..=d + 2).map(|x| scores.get(&x).copied().unwrap_or(0)).sum()))
        .collect();
    merged.sort_by(|x, y| y.1.cmp(&x.1).then(x.0.cmp(&y.0)));
    let mut out: Vec<i64> = Vec::new();
    for (d, v) in merged {
        if v < 15 {
            break;
        }
        if out.iter().all(|o| (o - d).abs() > 4) {
            out.push(d);
        }
        if out.len() >= n {
            break;
        }
    }
    out
}

/// Longest stretch along offset `d` (frame i in a lines up with frame i-d in b).
fn best_run(a: &Fingerprint, b: &Fingerprint, d: i64) -> Option<(usize, usize, f32)> {
    let start = d.max(0) as usize;
    let end = (b.len() as i64 + d).min(a.len() as i64);
    if end <= start as i64 + WINDOW as i64 {
        return None;
    }
    let end = end as usize;
    let diff: Vec<f32> = (start..end)
        .map(|i| {
            let j = (i as i64 - d) as usize;
            if a.quiet[i] || b.quiet[j] {
                32.0
            } else {
                (a.bits[i] ^ b.bits[j]).count_ones() as f32
            }
        })
        .collect();
    // Running mean over WINDOW frames.
    let mut sum: f32 = diff[..WINDOW].iter().sum();
    let mut good = Vec::with_capacity(diff.len() - WINDOW + 1);
    good.push(sum / WINDOW as f32 <= MAX_MEAN_BITS);
    for k in WINDOW..diff.len() {
        sum += diff[k] - diff[k - WINDOW];
        good.push(sum / WINDOW as f32 <= MAX_MEAN_BITS);
    }
    // Collect stretches that pass, then join stretches separated by short dips
    // (a loud sound effect over the music, a scene cut) of up to GAP frames.
    let mut runs: Vec<(usize, usize)> = Vec::new();
    let mut run_start: Option<usize> = None;
    for (k, &g) in good.iter().chain(std::iter::once(&false)).enumerate() {
        match (g, run_start) {
            (true, None) => run_start = Some(k),
            (false, Some(s)) => {
                runs.push((s, k - 1 + WINDOW)); // last window covers frames up to here
                run_start = None;
            }
            _ => {}
        }
    }
    let mut joined: Vec<(usize, usize)> = Vec::new();
    for r in runs {
        match joined.last_mut() {
            Some(last) if r.0 <= last.1 + GAP => last.1 = last.1.max(r.1),
            _ => joined.push(r),
        }
    }
    let (s, e) = joined.into_iter().max_by_key(|(s, e)| e - s)?;
    let mean = diff[s..e].iter().sum::<f32>() / (e - s) as f32;
    if mean > MAX_MEAN_BITS + 1.0 {
        return None;
    }
    Some((start + s, start + e, mean))
}

/// Finds the longest audio both fingerprints share, at least `min_seconds` long.
pub fn find_common(a: &Fingerprint, b: &Fingerprint, min_seconds: f32) -> Option<Common> {
    let min_frames = (min_seconds * FPS) as usize;
    let mut best: Option<Common> = None;
    for d in top_offsets(a, b, 6) {
        for dd in [d - 1, d, d + 1] {
            let Some((s, e, mean)) = best_run(a, b, dd) else { continue };
            if e - s < min_frames {
                continue;
            }
            let c = Common {
                a_start: s as f32 / FPS,
                a_end: e as f32 / FPS,
                b_start: (s as i64 - dd) as f32 / FPS,
                b_end: (e as i64 - dd) as f32 / FPS,
                mean_bits: mean,
            };
            if best.map(|bst| c.len() > bst.len() + 0.5).unwrap_or(true) {
                best = Some(c);
            }
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Small deterministic noise generator, so tests are repeatable.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> i16 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((self.0 >> 33) as i32 % 8000) as i16
        }
        fn noise(&mut self, seconds: f32) -> Vec<i16> {
            (0..(seconds * RATE as f32) as usize).map(|_| self.next()).collect()
        }
    }

    fn scaled(v: &[i16], f: f32) -> Vec<i16> {
        v.iter().map(|s| (*s as f32 * f) as i16).collect()
    }

    #[test]
    fn finds_a_shared_intro_at_different_places() {
        let intro = Lcg(42).noise(30.0);
        let mut a = Lcg(1).noise(20.0);
        a.extend(&intro);
        a.extend(Lcg(2).noise(40.0));
        let mut b = Lcg(3).noise(5.0);
        b.extend(scaled(&intro, 0.7)); // same intro, quieter
        b.extend(Lcg(4).noise(50.0));

        let c = find_common(&fingerprint(&a), &fingerprint(&b), 10.0).expect("intro found");
        assert!((c.a_start - 20.0).abs() < 1.5, "{c:?}");
        assert!((c.b_start - 5.0).abs() < 1.5, "{c:?}");
        assert!((c.len() - 30.0).abs() < 2.0, "{c:?}");
        assert!(c.mean_bits < 6.0, "{c:?}");
    }

    #[test]
    fn survives_noise_like_a_different_encode() {
        // A "song": chords that change every half second.
        let song: Vec<i16> = (0..(25.0 * RATE as f32) as usize)
            .map(|i| {
                let t = i as f32 / RATE as f32;
                let step = (t * 2.0) as usize;
                let f1 = 300.0 + (step * 37 % 17) as f32 * 60.0;
                let f2 = f1 * 1.5;
                (3000.0 * (2.0 * std::f32::consts::PI * f1 * t).sin() + 2000.0 * (2.0 * std::f32::consts::PI * f2 * t).sin()) as i16
            })
            .collect();
        let mut hiss = Lcg(99);
        let noisy: Vec<i16> = song.iter().map(|s| s.saturating_add(hiss.next() / 12)).collect();
        let mut a = Lcg(5).noise(12.0);
        a.extend(&song);
        a.extend(Lcg(6).noise(30.0));
        let mut b = Lcg(9).noise(31.0);
        b.extend(&noisy);
        b.extend(Lcg(10).noise(10.0));
        let c = find_common(&fingerprint(&a), &fingerprint(&b), 10.0).expect("song found");
        assert!((c.a_start - 12.0).abs() < 1.5 && (c.b_start - 31.0).abs() < 1.5, "{c:?}");
        assert!(c.len() > 22.0, "{c:?}");
    }

    #[test]
    fn unrelated_audio_has_no_match() {
        let a = fingerprint(&Lcg(7).noise(60.0));
        let b = fingerprint(&Lcg(8).noise(60.0));
        assert!(find_common(&a, &b, 10.0).is_none());
    }

    #[test]
    fn silence_does_not_match() {
        let quiet = vec![0i16; (40.0 * RATE as f32) as usize];
        let a = fingerprint(&quiet);
        assert!(a.quiet.iter().all(|q| *q));
        assert!(find_common(&a, &a, 5.0).is_none());
    }

    #[test]
    fn fft_matches_a_plain_dft() {
        let n = 16;
        let tw: Vec<(f32, f32)> = (0..n / 2)
            .map(|k| {
                let a = -2.0 * std::f64::consts::PI * k as f64 / n as f64;
                (a.cos() as f32, a.sin() as f32)
            })
            .collect();
        let x: Vec<f32> = (0..n).map(|i| ((i * 7 % 5) as f32) - 2.0).collect();
        let (mut re, mut im) = (x.clone(), vec![0f32; n]);
        fft(&mut re, &mut im, &tw);
        for k in 0..n {
            let (mut sr, mut si) = (0f64, 0f64);
            for (t, v) in x.iter().enumerate() {
                let a = -2.0 * std::f64::consts::PI * (k * t) as f64 / n as f64;
                sr += *v as f64 * a.cos();
                si += *v as f64 * a.sin();
            }
            assert!((re[k] as f64 - sr).abs() < 1e-3 && (im[k] as f64 - si).abs() < 1e-3, "bin {k}");
        }
    }

    #[test]
    fn short_input_gives_empty_fingerprint() {
        assert!(fingerprint(&[0i16; 100]).is_empty());
    }
}
