// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Sadece eth_call içinde, state override ile rastgele bir adrese yerleştirilip çalıştırılır.
// Hiçbir zaman dağıtılmaz. Gerçek bir V2 tipi havuzda (Uniswap V2 / AGIChainAI / Aerodrome volatile)
// alım -> cüzdandan cüzdana transfer -> satım simülasyonu yapar; honeypot ve vergileri ölçer.

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

interface IWETH {
    function deposit() external payable;
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IPair {
    function token0() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
    function swap(uint256, uint256, address, bytes calldata) external;
}

interface IAeroPool {
    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256);
}

contract Alici {
    // Transfer testinin alıcısı; aldığı tokeni geri gönderebilir.
    function geri(address token, address to) external returns (uint256 n) {
        n = IERC20(token).balanceOf(address(this));
        IERC20(token).transfer(to, n);
    }
}

contract AlimSatimSim {
    struct Sonuc {
        bool alimOk;
        bool transferOk;
        bool satimOk;
        uint256 beklenenAlim;   // vergisiz beklenen token
        uint256 alinan;         // gerçekte gelen token
        uint256 transferGiden;  // transfer edilen
        uint256 transferUlasan; // karşıya ulaşan
        uint256 satimGiden;     // havuza gönderilen
        uint256 havuzaUlasan;   // havuzun gerçekten aldığı
        uint256 beklenenWeth;   // gönderilen tutar vergisiz ulaşsaydı gelecek WETH
        uint256 gelenWeth;      // gerçekte gelen WETH
        string hata;
    }

    function _out(address pair, bool aero, address tokenIn, uint256 amountIn, uint256 rIn, uint256 rOut) internal view returns (uint256) {
        if (aero) {
            try IAeroPool(pair).getAmountOut(amountIn, tokenIn) returns (uint256 o) { return o; } catch {}
        }
        uint256 f = amountIn * 997;
        return (f * rOut) / (rIn * 1000 + f);
    }

    function _rezerv(address pair, bool tokenIs0) internal view returns (uint256 rT, uint256 rW) {
        (uint112 a, uint112 b, ) = IPair(pair).getReserves();
        (rT, rW) = tokenIs0 ? (uint256(a), uint256(b)) : (uint256(b), uint256(a));
    }

    function calistir(address pair, address token, address weth, bool aero) external payable returns (Sonuc memory s) {
        bool t0 = IPair(pair).token0() == token;
        IWETH(weth).deposit{value: msg.value}();

        // 1) Alım
        (uint256 rT, uint256 rW) = _rezerv(pair, t0);
        s.beklenenAlim = _out(pair, aero, weth, msg.value, rW, rT);
        if (s.beklenenAlim == 0) { s.hata = "no output"; return s; }
        IWETH(weth).transfer(pair, msg.value);
        uint256 once = IERC20(token).balanceOf(address(this));
        try IPair(pair).swap(t0 ? s.beklenenAlim : 0, t0 ? 0 : s.beklenenAlim, address(this), new bytes(0)) {
            s.alinan = IERC20(token).balanceOf(address(this)) - once;
            s.alimOk = s.alinan > 0;
        } catch Error(string memory r) { s.hata = string.concat("buy: ", r); return s; }
          catch { s.hata = "buy reverted"; return s; }
        if (!s.alimOk) { s.hata = "buy returned 0 tokens"; return s; }

        // 2) Cüzdandan cüzdana transfer (alınanın %10'u, sonra geri)
        Alici al = new Alici();
        s.transferGiden = s.alinan / 10;
        if (s.transferGiden > 0) {
            try IERC20(token).transfer(address(al), s.transferGiden) returns (bool) {
                s.transferUlasan = IERC20(token).balanceOf(address(al));
                s.transferOk = s.transferUlasan > 0;
                try al.geri(token, address(this)) {} catch {}
            } catch { s.transferOk = false; }
        }

        // 3) Satım: elde kalanın tamamı
        s.satimGiden = IERC20(token).balanceOf(address(this));
        (rT, rW) = _rezerv(pair, t0);
        uint256 havuzOnce = IERC20(token).balanceOf(pair);
        try IERC20(token).transfer(pair, s.satimGiden) returns (bool) {} catch Error(string memory r) {
            s.hata = string.concat("sell transfer: ", r); return s;
        } catch { s.hata = "sell transfer reverted"; return s; }
        s.havuzaUlasan = IERC20(token).balanceOf(pair) - havuzOnce;
        s.beklenenWeth = _out(pair, aero, token, s.satimGiden, rT, rW);
        // havuzOnce, rezervden fazla olabilir (birikmiş fazlalık); gerçek girdi = bakiye - rezerv
        uint256 girdi = IERC20(token).balanceOf(pair) - rT;
        uint256 cikis = _out(pair, aero, token, girdi, rT, rW);
        if (cikis == 0) { s.hata = "sell output 0"; return s; }
        uint256 wOnce = IWETH(weth).balanceOf(address(this));
        try IPair(pair).swap(t0 ? 0 : cikis, t0 ? cikis : 0, address(this), new bytes(0)) {
            s.gelenWeth = IWETH(weth).balanceOf(address(this)) - wOnce;
            s.satimOk = s.gelenWeth > 0;
        } catch Error(string memory r) { s.hata = string.concat("sell: ", r); }
          catch { s.hata = "sell reverted"; }
    }
}
