"""LGBModel variant that early-stops on cross-sectional RankIC instead of l2.

Standard qlib ``LGBModel`` early-stops on the regression loss (mse). For
cross-sectional alpha signals the quantity we actually care about is the per-day
rank correlation (Rank IC), which mse early-stopping does not optimize for.
Experiments on the 50-ETF lake (SP-5d 55-feature panel) show that early-stopping
on a custom RankIC feval lifts RankIC 0.047 -> 0.075 vs. the mse-stopped model.

This class reuses ``LGBModel``'s data preparation but:

  - tags each ``lgb.Dataset`` with per-day query ``group`` sizes so a ranking
    metric can be computed per trading day;
  - injects a custom ``feval`` (mean per-day Spearman of pred vs label) into
    ``lgb.train``; early stopping then selects the iteration that maximizes
    RankIC on the valid set;
  - forces ``metric='None'`` + ``first_metric_only=True`` so early-stopping
    tracks RankIC only (not the regression loss).

Wired into a workflow yaml like:

    model:
        class: RankICLGBModel
        module_path: tac_qlib.contrib.model.rank_gbdt
        kwargs:
            loss: mse
            learning_rate: 0.03
            num_leaves: 31
            n_estimators: 500
            ...

The rank feval is used for early-stopping selection only; the objective stays
the configured loss (default mse). Set ``rank_eval=False`` to fall back to the
plain LGBModel behaviour (early-stop on the loss).

Generic: works for any cross-sectional panel whose qlib dataset index has a
``datetime`` level (each level value = one query group). The per-day groups are
derived automatically, so no universe-specific configuration is needed.
"""

from __future__ import annotations

from typing import List, Optional, Tuple

import numpy as np
import pandas as pd
import lightgbm as lgb

from qlib.data.dataset import DatasetH
from qlib.data.dataset.handler import DataHandlerLP
from qlib.contrib.model.gbdt import LGBModel
from qlib.workflow import R

__all__ = ["RankICLGBModel", "rankic_feval"]


def _group_averaged_rank(values: np.ndarray, gid: np.ndarray, offs: np.ndarray) -> np.ndarray:
    """Averaged (tie-corrected) rank of ``values`` within each group, vectorized.

    ``gid`` maps each row to its group id; ``offs`` holds the cumulative row
    offsets so that group ``i`` occupies rows ``[offs[i], offs[i+1])``. Returns
    the same result as ``pandas.Series.rank(method='average')`` applied per
    group, but in one pass (``np.lexsort`` is the only non-linear step).
    """
    n = len(values)
    order = np.lexsort((values, gid))
    ord_rank = np.empty(n, dtype=np.float64)
    ord_rank[order] = np.arange(n, dtype=np.float64) - offs[gid[order]] + 1.0
    sg = gid[order]
    sv = values[order]
    newblock = np.empty(n, dtype=bool)
    newblock[0] = True
    newblock[1:] = (sg[1:] != sg[:-1]) | (sv[1:] != sv[:-1])
    blockid = np.cumsum(newblock) - 1
    block_mean = np.bincount(blockid, weights=ord_rank[order]) / np.bincount(blockid)
    out = np.empty(n)
    out[order] = block_mean[blockid]
    return out


def _per_day_spearman(preds: np.ndarray, labels: np.ndarray, group: np.ndarray) -> float:
    """Mean per-day Spearman rank correlation of preds vs labels.

    ``group`` holds the number of rows of each trading day (query group), in
    order. Days with <3 valid rows or a constant pred/label are skipped.

    Vectorized: per-day Spearman == Pearson of the per-day rank transforms,
    and the Pearson moments (``sum``, ``sum`` of products/squares) aggregate
    over each day with ``np.bincount``. Runs ~10x faster than the per-day
    ``pd.Series.rank()`` loop that preceded it — this feval is invoked on the
    train and valid panels every boosting round, per seed.
    """
    if group is None or len(group) == 0:
        return 0.0
    offs = np.concatenate([[0], np.cumsum(group.astype(int))])
    gid = np.repeat(np.arange(len(group)), group.astype(int))
    rp = _group_averaged_rank(preds, gid, offs)
    rl = _group_averaged_rank(labels, gid, offs)
    n_g = group.astype(float)
    s_p = np.bincount(gid, weights=rp)
    s_l = np.bincount(gid, weights=rl)
    s_pl = np.bincount(gid, weights=rp * rl)
    s_pp = np.bincount(gid, weights=rp * rp)
    s_ll = np.bincount(gid, weights=rl * rl)
    cov = n_g * s_pl - s_p * s_l
    var_p = n_g * s_pp - s_p ** 2
    var_l = n_g * s_ll - s_l ** 2
    denom = np.sqrt(var_p * var_l)
    valid = (n_g >= 3) & (denom > 0)
    corr = np.where(valid, cov / np.where(denom == 0, 1, denom), 0.0)
    return float(corr[valid].mean()) if valid.any() else 0.0


def rankic_feval(preds, dataset):
    """LightGBM feval: mean RankIC (higher is better in lgb convention)."""
    labels = dataset.get_label()
    group = dataset.get_group()
    ric = _per_day_spearman(preds, labels, group)
    return "rankic", ric, True  # (name, value, higher_is_better)


class RankICLGBModel(LGBModel):
    """LGBModel that early-stops on per-day RankIC via a custom feval."""

    def __init__(self, rank_eval: bool = True, **kwargs):
        super().__init__(**kwargs)
        self.rank_eval = rank_eval

    def _prepare_data(self, dataset: DatasetH, reweighter=None) -> List[Tuple[lgb.Dataset, str]]:
        ds_l = []
        assert "train" in dataset.segments
        for key in ["train", "valid"]:
            if key in dataset.segments:
                df = dataset.prepare(key, col_set=["feature", "label"], data_key=DataHandlerLP.DK_L)
                if df.empty:
                    raise ValueError("Empty data from dataset, please check your dataset config.")
                x, y = df["feature"], df["label"]
                if y.values.ndim == 2 and y.values.shape[1] == 1:
                    y = np.squeeze(y.values)
                else:
                    raise ValueError("LightGBM doesn't support multi-label training")

                if reweighter is None:
                    w = None
                elif hasattr(reweighter, "reweight"):
                    w = reweighter.reweight(df)
                else:
                    raise ValueError("Unsupported reweighter type.")

                # per-day query groups: each trading day is one group
                if self.rank_eval and isinstance(df.index, pd.MultiIndex) and "datetime" in df.index.names:
                    group = df.groupby(level="datetime").size().to_numpy(dtype=np.int32)
                else:
                    group = None

                d = lgb.Dataset(x.values, label=y, weight=w, group=group, free_raw_data=False)
                ds_l.append((d, key))
        return ds_l

    def _train_from_datasets(
        self,
        ds_l: List[Tuple[lgb.Dataset, str]],
        num_boost_round: Optional[int] = None,
        early_stopping_rounds: Optional[int] = None,
        verbose_eval: int = 20,
        evals_result=None,
        **kwargs,
    ) -> Tuple[lgb.Booster, dict, List[str]]:
        """Train a Booster from already-prepared ``lgb.Dataset`` objects.

        Pure training — no ``R.log_metrics`` — so it can be called from worker
        threads (qlib's ``R`` recorder is not thread-safe; the caller decides
        when/where to log). Returns ``(booster, evals_result, segment_names)``.
        """
        if evals_result is None:
            evals_result = {}
        ds, names = list(zip(*ds_l))

        callbacks = [
            lgb.early_stopping(
                self.early_stopping_rounds if early_stopping_rounds is None else early_stopping_rounds
            ),
            lgb.log_evaluation(period=verbose_eval),
            lgb.record_evaluation(evals_result),
        ]
        if self.rank_eval:
            # early-stopping must be driven ONLY by the RankIC feval, not l2.
            # metric='None' suppresses the default l2 metric; first_metric_only
            # makes early_stopping track the single remaining (rankic) metric.
            self.params["metric"] = "None"
            self.params["first_metric_only"] = True
            feval = rankic_feval
        else:
            self.params.pop("metric", None)
            self.params.pop("first_metric_only", None)
            feval = None

        booster = lgb.train(
            self.params,
            ds[0],
            num_boost_round=self.num_boost_round if num_boost_round is None else num_boost_round,
            valid_sets=ds,
            valid_names=names,
            feval=feval,
            callbacks=callbacks,
            **kwargs,
        )
        return booster, evals_result, list(names)

    def _log_evals(self, evals_result, names: List[str], prefix: str = "") -> None:
        """Log recorded evaluation curves to qlib's active recorder."""
        for k in names:
            for key, val in evals_result.get(k, {}).items():
                name = f"{prefix}{key}.{k}"
                for epoch, m in enumerate(val):
                    R.log_metrics(**{name.replace("@", "_"): m}, step=epoch)

    def fit(
        self,
        dataset: DatasetH,
        num_boost_round: Optional[int] = None,
        early_stopping_rounds: Optional[int] = None,
        verbose_eval: int = 20,
        evals_result=None,
        reweighter=None,
        **kwargs,
    ):
        if evals_result is None:
            evals_result = {}
        ds_l = self._prepare_data(dataset, reweighter)
        self.model, evals_result, names = self._train_from_datasets(
            ds_l,
            num_boost_round=num_boost_round,
            early_stopping_rounds=early_stopping_rounds,
            verbose_eval=verbose_eval,
            evals_result=evals_result,
            **kwargs,
        )
        self._log_evals(evals_result, names)
