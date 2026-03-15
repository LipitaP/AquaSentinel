"""
AquaSentinel — Module 1: Core Analytics Engine
================================================
SpectralAuditor: Vectorized spectral index computation and temporal
damage quantification using NumPy. Optimized for CPU-bound processing.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Dict, Tuple

import numpy as np

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Result Schema
# ---------------------------------------------------------------------------

@dataclass
class DamageResult:
    """Quantified damage metrics produced by SpectralAuditor."""
    forest_loss_pct: float        # % of pixels with significant NDVI decline
    water_depletion_pct: float    # % of pixels with significant NDWI decline
    severity_index: float         # Composite 0-100 damage score
    ndvi_baseline: np.ndarray = field(repr=False, default_factory=lambda: np.array([]))
    ndvi_current: np.ndarray = field(repr=False, default_factory=lambda: np.array([]))
    ndwi_baseline: np.ndarray = field(repr=False, default_factory=lambda: np.array([]))
    ndwi_current: np.ndarray = field(repr=False, default_factory=lambda: np.array([]))
    ndvi_delta: np.ndarray = field(repr=False, default_factory=lambda: np.array([]))
    ndwi_delta: np.ndarray = field(repr=False, default_factory=lambda: np.array([]))
    pixel_count: int = 0


# ---------------------------------------------------------------------------
# Spectral Auditor
# ---------------------------------------------------------------------------

class SpectralAuditor:
    """
    Vectorized spectral auditor for Sentinel-2 multispectral raster data.

    Band conventions (0-indexed in input arrays):
        B3  → Green  (index 0)
        B4  → Red    (index 1)
        B8  → NIR    (index 2)

    All operations use NumPy vectorized math — no Python-level pixel loops.
    """

    # Thresholds for "significant" change detection
    NDVI_LOSS_THRESHOLD: float = -0.05   # Drop > 5 NDVI units → biomass loss
    NDWI_LOSS_THRESHOLD: float = -0.03   # Drop > 3 NDWI units → water loss
    EPSILON: float = 1e-10               # Numerical stability guard

    def __init__(self, nodata: float = -9999.0) -> None:
        self.nodata = nodata

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def calculate_damage(
        self,
        t1_data: np.ndarray,
        t2_data: np.ndarray,
    ) -> DamageResult:
        """
        Compute temporal damage between two Sentinel-2 raster windows.

        Parameters
        ----------
        t1_data : ndarray, shape (3, H, W)
            Baseline acquisition bands [B3, B4, B8] normalised to [0, 1].
        t2_data : ndarray, shape (3, H, W)
            Current acquisition bands [B3, B4, B8] normalised to [0, 1].

        Returns
        -------
        DamageResult
        """
        t1 = self._preprocess(t1_data)
        t2 = self._preprocess(t2_data)

        # --- Spectral indices ---
        ndvi_t1 = self.compute_ndvi(t1[2], t1[1])   # B8, B4
        ndvi_t2 = self.compute_ndvi(t2[2], t2[1])

        ndwi_t1 = self.compute_ndwi(t1[0], t1[2])   # B3, B8
        ndwi_t2 = self.compute_ndwi(t2[0], t2[2])

        # --- Temporal deltas (positive = gain, negative = loss) ---
        ndvi_delta = np.subtract(ndvi_t2, ndvi_t1)
        ndwi_delta = np.subtract(ndwi_t2, ndwi_t1)

        # Force numerical stability
        ndvi_delta = np.nan_to_num(ndvi_delta, nan=0.0, posinf=0.0, neginf=0.0)
        ndwi_delta = np.nan_to_num(ndwi_delta, nan=0.0, posinf=0.0, neginf=0.0)

        # --- Valid pixel mask (exclude nodata regions) ---
        valid_mask = self._valid_mask(t1, t2)
        pixel_count = int(np.sum(valid_mask))

        if pixel_count == 0:
            logger.warning("No valid pixels found in raster window.")
            return DamageResult(0.0, 0.0, 0.0, pixel_count=0)

        # --- Loss quantification ---
        forest_loss_pct = self._loss_percentage(
            ndvi_delta, valid_mask, self.NDVI_LOSS_THRESHOLD
        )
        water_depletion_pct = self._loss_percentage(
            ndwi_delta, valid_mask, self.NDWI_LOSS_THRESHOLD
        )

        # --- Composite severity index [0-100] ---
        severity_index = self._severity(ndvi_delta, ndwi_delta, valid_mask)

        logger.info(
            "Audit complete | pixels=%d | forest_loss=%.2f%% | "
            "water_depletion=%.2f%% | severity=%.1f",
            pixel_count, forest_loss_pct, water_depletion_pct, severity_index,
        )

        return DamageResult(
            forest_loss_pct=round(forest_loss_pct, 2),
            water_depletion_pct=round(water_depletion_pct, 2),
            severity_index=round(severity_index, 1),
            ndvi_baseline=ndvi_t1,
            ndvi_current=ndvi_t2,
            ndwi_baseline=ndwi_t1,
            ndwi_current=ndwi_t2,
            ndvi_delta=ndvi_delta,
            ndwi_delta=ndwi_delta,
            pixel_count=pixel_count,
        )

    # ------------------------------------------------------------------
    # Core Spectral Indices
    # ------------------------------------------------------------------

    @classmethod
    def compute_ndvi(cls, b8: np.ndarray, b4: np.ndarray) -> np.ndarray:
        """
        Normalised Difference Vegetation Index.
        NDVI = (B8 - B4) / (B8 + B4 + ε)

        Returns float32 array in range [-1, 1].
        """
        b8 = b8.astype(np.float32, copy=False)
        b4 = b4.astype(np.float32, copy=False)
        ndvi = np.divide(
            np.subtract(b8, b4),
            np.add(np.add(b8, b4), cls.EPSILON),
        )
        return np.nan_to_num(ndvi, nan=0.0, posinf=1.0, neginf=-1.0)

    @classmethod
    def compute_ndwi(cls, b3: np.ndarray, b8: np.ndarray) -> np.ndarray:
        """
        Normalised Difference Water Index (McFeeters 1996).
        NDWI = (B3 - B8) / (B3 + B8 + ε)

        Returns float32 array in range [-1, 1].
        """
        b3 = b3.astype(np.float32, copy=False)
        b8 = b8.astype(np.float32, copy=False)
        ndwi = np.divide(
            np.subtract(b3, b8),
            np.add(np.add(b3, b8), cls.EPSILON),
        )
        return np.nan_to_num(ndwi, nan=0.0, posinf=1.0, neginf=-1.0)

    # ------------------------------------------------------------------
    # Internal Helpers
    # ------------------------------------------------------------------

    def _preprocess(self, data: np.ndarray) -> np.ndarray:
        """Normalise uint16 Sentinel-2 reflectance [0-10000] → [0, 1] float32."""
        arr = np.asarray(data, dtype=np.float32)
        if arr.max() > 1.0:
            arr = np.divide(arr, 10000.0)
        arr = np.nan_to_num(arr, nan=0.0)
        return np.clip(arr, 0.0, 1.0)

    def _valid_mask(self, t1: np.ndarray, t2: np.ndarray) -> np.ndarray:
        """Boolean mask of pixels valid in both time steps (all bands)."""
        valid_t1 = np.all(t1 > 0.0, axis=0)
        valid_t2 = np.all(t2 > 0.0, axis=0)
        return np.logical_and(valid_t1, valid_t2)

    @staticmethod
    def _loss_percentage(
        delta: np.ndarray,
        mask: np.ndarray,
        threshold: float,
    ) -> float:
        """Fraction of valid pixels whose delta is below the loss threshold."""
        loss_pixels = np.sum(np.logical_and(delta < threshold, mask))
        valid_count = np.sum(mask)
        if valid_count == 0:
            return 0.0
        return float(loss_pixels / valid_count * 100.0)

    @staticmethod
    def _severity(
        ndvi_delta: np.ndarray,
        ndwi_delta: np.ndarray,
        mask: np.ndarray,
    ) -> float:
        """
        Composite severity index on [0, 100].

        Combines mean NDVI loss (weighted 60%) and mean NDWI loss (weighted 40%),
        then maps to a 0-100 scale where 100 = catastrophic.
        """
        valid_ndvi = ndvi_delta[mask]
        valid_ndwi = ndwi_delta[mask]

        if valid_ndvi.size == 0:
            return 0.0

        # Mean negative delta (losses only; gains clamped to 0)
        mean_ndvi_loss = float(np.mean(np.clip(-valid_ndvi, 0.0, None)))
        mean_ndwi_loss = float(np.mean(np.clip(-valid_ndwi, 0.0, None)))

        # Weighted composite — NDVI range [-1,1], map max expected loss ~0.5
        composite = (0.60 * mean_ndvi_loss + 0.40 * mean_ndwi_loss)
        severity = np.clip(composite / 0.5 * 100.0, 0.0, 100.0)
        return float(severity)


# ---------------------------------------------------------------------------
# Mock Raster Generator (used when live Sentinel-2 data is unavailable)
# ---------------------------------------------------------------------------

class MockRasterFactory:
    """
    Generates statistically plausible synthetic Sentinel-2 raster patches
    for testing and demo purposes when real data is unavailable.
    """

    RNG = np.random.default_rng(seed=42)

    @classmethod
    def make_baseline(
        cls,
        height: int = 256,
        width: int = 256,
        damage_level: float = 0.0,
    ) -> np.ndarray:
        """
        Generate a healthy-forest raster (T1 baseline).
        Returns shape (3, H, W) with bands [B3, B4, B8] in [0, 1] float32.
        """
        base = cls._spatial_noise(height, width)

        b3 = np.clip(0.06 + 0.03 * base, 0.02, 0.12)   # Green — moderate
        b4 = np.clip(0.05 + 0.02 * base, 0.01, 0.10)   # Red   — low (absorbed)
        b8 = np.clip(0.45 + 0.15 * base, 0.25, 0.75)   # NIR   — high (vegetation)

        return np.stack([b3, b4, b8], axis=0).astype(np.float32)

    @classmethod
    def make_damaged(
        cls,
        baseline: np.ndarray,
        damage_level: float = 0.4,
    ) -> np.ndarray:
        """
        Degrade a baseline raster to simulate post-mining damage.

        Parameters
        ----------
        baseline : ndarray, shape (3, H, W)
        damage_level : float in [0, 1]; 0=intact 1=total damage
        """
        degraded = baseline.copy()
        _, H, W = baseline.shape
        noise = cls._spatial_noise(H, W)

        # Simulate vegetation clearing: NIR drops, Red rises
        nir_loss = damage_level * (0.30 + 0.10 * np.abs(noise))
        red_gain  = damage_level * (0.05 + 0.03 * np.abs(noise))

        degraded[2] = np.clip(baseline[2] - nir_loss, 0.01, 1.0)  # B8↓
        degraded[1] = np.clip(baseline[1] + red_gain,  0.01, 1.0)  # B4↑
        degraded[0] = np.clip(baseline[0] - damage_level * 0.02, 0.01, 1.0)  # B3↓

        return degraded.astype(np.float32)

    @classmethod
    def _spatial_noise(cls, H: int, W: int) -> np.ndarray:
        """Smooth spatial noise using a simple box-blur approximation."""
        raw = cls.RNG.standard_normal((H, W)).astype(np.float32)
        # Vectorised 5-pixel rolling mean approximation
        kernel = np.ones((5, 5), dtype=np.float32) / 25.0
        from numpy.lib.stride_tricks import sliding_window_view
        p = 2  # padding
        padded = np.pad(raw, p, mode='reflect')
        windows = sliding_window_view(padded, (5, 5))
        smooth = np.einsum('ijkl,kl->ij', windows, kernel)
        return smooth
