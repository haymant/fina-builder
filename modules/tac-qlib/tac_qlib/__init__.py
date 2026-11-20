"""tac-qlib: read the TradeAC parquet lake from within the qlib research workflow.

This package is fully decoupled from the upstream ``qlib`` checkout. It provides:

- ``tac_qlib.qlib_init.qlib_init``: drop-in ``qlib.init`` configured against the lake.
- ``tac_qlib.data.providers``: qlib data providers (calendar / instruments / features)
  backed by the lake parquet files, so ``qlib.init`` + ``D.features`` work without any
  ``*.bin`` data.
- ``tac_qlib.contrib.data.handler``: a ``DataHandlerLP`` subclass (``TACHandler``) that
  builds a train/test dataset from raw OHLCV + pre-computed ta-lib features.

Upstream ``qlib/`` is never modified.
"""

from .qlib_init import qlib_init, provider_config

__all__ = ["qlib_init", "provider_config"]
__version__ = "0.1.0"
