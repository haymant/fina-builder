//! Deterministic PRNG: a bit-exact port of the TypeScript `createRng`.
//!
//! # Bit-exactness contract
//!
//! The TypeScript original is:
//!
//! ```js
//! function createRng(seed) {
//!   let t = seed >>> 0
//!   return () => {
//!     t += 0x6d2b79f5
//!     let r = Math.imul(t ^ (t >>> 15), 1 | t)
//!     r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
//!     return ((r ^ (r >>> 14)) >>> 0) / 4294967296
//!   }
//! }
//! ```
//!
//! JS numbers are doubles, so `t += 0x6d2b79f5` can exceed 2^32 and relies on
//! `ToUint32`/`ToInt32` coercion inside the bitwise operators to wrap. A `u32`
//! implementation is equivalent because `+`, `^`, `<<`, `>>` all agree on the
//! low 32 bits regardless of signedness, and the final `>>> 0` reinterprets the
//! result as unsigned before the float division.
//!
//! # Draw-order contract
//!
//! The path generator consumes a **fixed number of draws in a fixed order** for
//! every path. Adding, removing or reordering one draw shifts every subsequent
//! value for every path and breaks golden parity. See `PHASE1_MIGRATION_PROMPT.md`
//! pitfall P-3.

/// Mulberry32 — a small, fast, deterministic 32-bit PRNG.
///
/// The port consumes exactly four draws per path up front (one scenario pick,
/// three initial underlying spots), then a variable number of per-observation
/// draws, then two more in `refine_attribution`.
#[derive(Debug, Clone)]
pub struct Mulberry32 {
    t: u32,
}

/// The `1` in the TypeScript `1 | t`. Named for readability; value is exact.
const LOW_BITS_1: u32 = 1;

/// The `61` in the TypeScript `61 | r`. Named for readability; value is exact.
const LOW_BITS_61: u32 = 61;

impl Mulberry32 {
    /// Creates a generator from `seed`. The value is truncated to 32 bits, which
    /// mirrors the TypeScript `seed >>> 0`.
    #[must_use]
    pub fn new(seed: u32) -> Self {
        Self { t: seed }
    }

    /// Returns the next raw 32-bit value.
    ///
    /// This is a line-by-line port; the decimal literals `1` and `61` are kept
    /// exactly as the TypeScript writes them so the two can be diffed by eye.
    /// `LOW_BITS_1` and `LOW_BITS_61` are the same values, named so the bitwise
    /// intent is readable.
    pub fn next_u32(&mut self) -> u32 {
        self.t = self.t.wrapping_add(0x6D2B_79F5);
        let mut r = (self.t ^ (self.t >> 15)).wrapping_mul(LOW_BITS_1 | self.t);
        r ^= r.wrapping_add((r ^ (r >> 7)).wrapping_mul(LOW_BITS_61 | r));
        r ^ (r >> 14)
    }

    /// Returns the next value in `[0, 1)`.
    ///
    /// Dividing the `u32` by `2^32` as an `f64` is exact for all 2^32 inputs and
    /// matches the TypeScript `(u32 / 4294967296)` exactly.
    pub fn next_f64(&mut self) -> f64 {
        f64::from(self.next_u32()) / 4_294_967_296.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reference sequence produced by `node -e` using the literal TypeScript
    /// function. This table is the contract.
    const SEED_42_U32: [u32; 8] = [
        2_581_720_956,
        1_925_393_290,
        3_661_312_704,
        2_876_485_805,
        750_819_978,
        2_261_697_747,
        1_173_505_300,
        2_683_257_857,
    ];

    /// First four `next_f64()` draws for seed 42, from the same Node run.
    ///
    /// These are the shortest round-tripping decimal forms (`String(x)` in
    /// JavaScript). Transcribing from `toPrecision(20)` loses digits and
    /// produces a *different* f64, which this test then correctly rejects.
    const SEED_42_F64: [f64; 4] = [
        0.601_103_751_920_163_6,
        0.448_290_558_997_541_67,
        0.852_465_793_490_409_9,
        0.669_734_041_439_369_3,
    ];

    #[test]
    fn matches_typescript_reference_sequence_for_seed_42() {
        let mut rng = Mulberry32::new(42);
        for (i, expected) in SEED_42_U32.iter().enumerate() {
            assert_eq!(
                rng.next_u32(),
                *expected,
                "draw {i} of seed 42 diverged from the TypeScript reference"
            );
        }
    }

    #[test]
    fn matches_typescript_reference_floats_for_seed_42() {
        let mut rng = Mulberry32::new(42);
        for (i, expected) in SEED_42_F64.iter().enumerate() {
            assert_eq!(
                rng.next_f64(),
                *expected,
                "float draw {i} of seed 42 diverged from the TypeScript reference"
            );
        }
    }

    #[test]
    fn next_f64_is_in_unit_interval() {
        let mut rng = Mulberry32::new(42);
        for _ in 0..10_000 {
            let v = rng.next_f64();
            assert!((0.0..1.0).contains(&v), "next_f64 out of range: {v}");
        }
    }

    #[test]
    fn next_f64_matches_u32_division() {
        let mut a = Mulberry32::new(7);
        let mut b = Mulberry32::new(7);
        for _ in 0..1_000 {
            let raw = a.next_u32();
            let f = b.next_f64();
            assert_eq!(f, f64::from(raw) / 4_294_967_296.0);
        }
    }

    #[test]
    fn two_instances_with_same_seed_agree() {
        let mut a = Mulberry32::new(123);
        let mut b = Mulberry32::new(123);
        for _ in 0..1_000 {
            assert_eq!(a.next_u32(), b.next_u32());
        }
    }

    #[test]
    fn different_seeds_diverge() {
        let mut a = Mulberry32::new(1);
        let mut b = Mulberry32::new(2);
        let sa: Vec<u32> = (0..16).map(|_| a.next_u32()).collect();
        let sb: Vec<u32> = (0..16).map(|_| b.next_u32()).collect();
        assert_ne!(sa, sb);
    }

    #[test]
    fn seed_zero_is_a_valid_stream() {
        // `seed >>> 0` in JS makes 0 a normal seed, not a special case.
        let mut rng = Mulberry32::new(0);
        let first = rng.next_u32();
        assert_ne!(first, 0, "seed 0 must still produce a stream");
        assert_ne!(first, Mulberry32::new(42).next_u32());
    }

    #[test]
    fn state_wraps_without_overflow_panic() {
        // Release builds wrap silently; debug builds must not panic. Drive enough
        // draws that `t` passes 2^32 several times over.
        let mut rng = Mulberry32::new(u32::MAX);
        for _ in 0..10_000 {
            let _ = rng.next_u32();
        }
    }

    #[test]
    fn clone_copies_state() {
        let mut a = Mulberry32::new(42);
        let _ = a.next_u32();
        let mut b = a.clone();
        assert_eq!(a.next_u32(), b.next_u32());
    }
}
