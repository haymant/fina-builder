"""Seed-ensembled LightGBM that early-stops on cross-sectional RankIC.

``RankICEnsembleLGBModel`` wraps ``RankICLGBModel`` (per-day RankIC feval +
``metric='None'`` + ``first_metric_only`` early stopping) over a seed ensemble:
one sub-model is trained per seed with identical hyper-parameters, and
predictions are averaged across seeds. This is the model class the
``tac-rd-rank-ensemble-isolated`` reference run wires into its workflow
(``module_path: tac_qlib.contrib.model.rank_ensemble``).

The ensemble inherits the RankIC early-stopping behaviour of the single-seed
model (valid RankIC drives the stopping iteration) while the seed averaging
stabilizes the prediction against any single seed's early-stopping path.

Training is parallelized: the seed sub-models train in a thread pool —
``lgb.train`` is C++ and releases the GIL, so concurrent seeds do not block on
the GIL (5 seeds ~40min/5 on this box). Measured on a 6-physical-core / 12 SMT
host: the seeds scale ~2x, not linearly — the runs are memory-bandwidth bound
and each Booster caps its threads at ``cores // workers`` so 5 concurrent
boosters don't oversubscribe; larger-core hosts scale better. The qlib data
pipeline is warmed once on the calling thread (fills the handler cache), and
each worker then prepares its **own** ``lgb.Dataset`` (independent handle, so
no concurrent ``construct()`` on a shared handle — LightGBM's ``Dataset`` is
not thread-safe to build). qlib's ``R`` recorder is also not thread-safe, so
the per-seed evaluation curves are logged on the calling thread after the pool
finishes.

Wired into a workflow yaml like:

    model:
        class: RankICEnsembleLGBModel
        module_path: tac_qlib.contrib.model.rank_ensemble
        kwargs:
            loss: mse
            learning_rate: 0.02
            num_leaves: 31
            n_estimators: 3000
            num_boost_round: 3000
            early_stopping_rounds: 200
            min_data_in_leaf: 20
            lambda_l2: 0.5
            colsample_bytree: 0.8
            subsample: 0.8
            subsample_freq: 1
            reg_alpha: 0.1
            reg_lambda: 1.0
            seeds: "42,7,2026,99,123"
            parallel: 5

Any ``**kwargs`` other than ``seeds``/``parallel`` are forwarded unchanged to
every ``RankICLGBModel`` sub-model (same params, different ``seed``).
"""

from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from typing import List, Optional

import pandas as pd

from qlib.data.dataset import DatasetH
from qlib.data.dataset.handler import DataHandlerLP

from tac_qlib.contrib.model.rank_gbdt import RankICLGBModel

__all__ = ["RankICEnsembleLGBModel"]


class RankICEnsembleLGBModel(RankICLGBModel):
    """Seed ensemble of RankIC-early-stopping LightGBM models.

    Parameters
    ----------
    seeds : comma-separated integers, one sub-model per seed.
    parallel : number of seeds to train concurrently. ``0`` (default) = auto
        (all seeds, bounded by the available cores); ``1`` = sequential.
    **kwargs : forwarded to every ``RankICLGBModel`` sub-model (model
        hyper-parameters). ``seeds``/``parallel`` are consumed here and not
        forwarded.
    """

    def __init__(self, seeds: str = "42", parallel: int = 0, **kwargs):
        self.seeds = [int(s.strip()) for s in str(seeds).split(",") if s.strip()]
        if not self.seeds:
            raise ValueError("seeds must contain at least one integer")
        self.parallel = int(parallel)
        # drop seed/parallel handling from the base kwargs, keep everything else
        self._model_kwargs = dict(kwargs)
        super().__init__(**self._model_kwargs)
        self._models: List[RankICLGBModel] = []

    # --------------------------------------------------------------- helpers
    @staticmethod
    def _cores() -> int:
        try:
            return max(1, len(os.sched_getaffinity(0)))
        except AttributeError:
            return max(1, os.cpu_count() or 1)

    def _worker_count(self) -> int:
        if self.parallel > 0:
            return min(len(self.seeds), self.parallel)
        return min(len(self.seeds), self._cores())

    # ------------------------------------------------------------------ fit
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
        """Train one RankICLGBModel per seed and keep them for prediction.

        The qlib data pipeline is warmed once on this thread (handler cache),
        then each seed sub-model trains in a parallel worker thread on its own
        ``lgb.Dataset`` (LightGBM releases the GIL in ``lgb.train``). Evals
        are logged on this thread after the pool (qlib's ``R`` is not
        thread-safe).
        """
        n_round = num_boost_round or self.num_boost_round
        n_es = early_stopping_rounds or self.early_stopping_rounds

        if len(self.seeds) == 1:
            m = RankICLGBModel(seed=self.seeds[0], **self._model_kwargs)
            m.fit(
                dataset,
                num_boost_round=n_round,
                early_stopping_rounds=n_es,
                verbose_eval=verbose_eval,
                evals_result=evals_result,
                reweighter=reweighter,
                **kwargs,
            )
            self._models = [m]
            return

        # Warm the qlib handler cache once on this thread so the workers'
        # concurrent prepare() calls only hit cached frames (no first-write race).
        proto = RankICLGBModel(seed=self.seeds[0], **self._model_kwargs)
        proto._prepare_data(dataset, reweighter)

        workers = self._worker_count()
        # Cap per-Booster threads so concurrent seeds don't oversubscribe
        # (LightGBM's num_threads=0 uses ALL cores per Booster).
        per_booster = max(1, self._cores() // workers)

        def fit_seed(seed):
            m = RankICLGBModel(seed=seed, **self._model_kwargs)
            if workers > 1 and "num_threads" not in m.params:
                m.params["num_threads"] = per_booster
            ds_l = m._prepare_data(dataset, reweighter)
            booster, evals, names = m._train_from_datasets(
                ds_l,
                num_boost_round=n_round,
                early_stopping_rounds=n_es,
                verbose_eval=verbose_eval,
                **kwargs,
            )
            m.model = booster
            return m, evals, names

        with ThreadPoolExecutor(max_workers=workers) as ex:
            results = list(ex.map(fit_seed, self.seeds))

        self._models = [m for m, _, _ in results]

        # Merge + log evals on the main thread (qlib's R is not thread-safe).
        if evals_result is not None:
            for m, evals, names in results:
                for k in names:
                    for key, val in evals.get(k, {}).items():
                        evals_result.setdefault(f"{k}.seed{m.params['seed']}", {})[key] = val
        for m, evals, names in results:
            self._log_evals(evals, names, prefix=f"seed{m.params['seed']}.")

    # -------------------------------------------------------------- predict
    def predict(self, dataset: DatasetH, segment="test") -> pd.Series:
        """Average the per-seed predictions over the given segment."""
        if not self._models:
            raise ValueError("model is not fitted yet!")
        preds = [m.predict(dataset, segment=segment) for m in self._models]
        if len(preds) == 1:
            return preds[0]
        frame = pd.concat(preds, axis=1)
        return frame.mean(axis=1)
