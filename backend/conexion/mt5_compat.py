try:
    import MetaTrader5 as mt5
except ImportError:
    class _Mt5Fallback:
        ACCOUNT_TRADE_MODE_DEMO = 0
        ACCOUNT_TRADE_MODE_CONTEST = 1
        ACCOUNT_TRADE_MODE_REAL = 2

        POSITION_TYPE_BUY = 0
        POSITION_TYPE_SELL = 1
        ORDER_TYPE_BUY = 0
        ORDER_TYPE_SELL = 1
        ORDER_TYPE_BUY_LIMIT = 2
        ORDER_TYPE_SELL_LIMIT = 3
        ORDER_TIME_GTC = 0
        ORDER_FILLING_FOK = 0
        ORDER_FILLING_IOC = 1
        ORDER_FILLING_RETURN = 2
        TRADE_RETCODE_DONE = 10009
        TRADE_ACTION_DEAL = 0
        TRADE_ACTION_SLTP = 3
        TRADE_ACTION_PENDING = 5
        DEAL_REASON_SL = 0
        DEAL_REASON_TP = 1

        TIMEFRAME_M1 = 1
        TIMEFRAME_M3 = 3
        TIMEFRAME_M5 = 5
        TIMEFRAME_M15 = 15
        TIMEFRAME_M30 = 30
        TIMEFRAME_H1 = 60
        TIMEFRAME_H2 = 120
        TIMEFRAME_H4 = 240
        TIMEFRAME_D1 = 1440
        TIMEFRAME_W1 = 10080
        TIMEFRAME_MN1 = 43200

        def __getattr__(self, name):
            if name.startswith(("TIMEFRAME_", "ACCOUNT_", "POSITION_TYPE_", "ORDER_TYPE_", "TRADE_")):
                return 0
            raise AttributeError(
                f"{type(self).__name__!r} object has no attribute {name!r}"
            )

        @staticmethod
        def last_error():
            return (-1, "MetaTrader5 library not installed")

        @staticmethod
        def initialize(*args, **kwargs):
            return False

        @staticmethod
        def login(*args, **kwargs):
            return False

        @staticmethod
        def shutdown(*args, **kwargs):
            return True

        @staticmethod
        def terminal_info(*args, **kwargs):
            return None

        @staticmethod
        def account_info(*args, **kwargs):
            return None

        @staticmethod
        def symbol_select(*args, **kwargs):
            return False

        @staticmethod
        def symbol_info(*args, **kwargs):
            return None

        @staticmethod
        def symbol_info_tick(*args, **kwargs):
            return None

        @staticmethod
        def copy_rates_from_pos(*args, **kwargs):
            return None

        @staticmethod
        def order_send(*args, **kwargs):
            return None

        @staticmethod
        def positions_get(*args, **kwargs):
            return None

        @staticmethod
        def history_deals_get(*args, **kwargs):
            return None

    mt5 = _Mt5Fallback()
    MT5_AVAILABLE = False
else:
    MT5_AVAILABLE = True
