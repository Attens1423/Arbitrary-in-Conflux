// package
const { Conflux, Drip } = require('./js-conflux-sdk-master/src');
const BN = require('bignumber.js')
const util = require('util');
const lodash = require('lodash');
const path = require("path");
const fs = require("fs");

// cfx 
const cfx = new Conflux({
    url: "http://main.confluxrpc.org",
    defaultGasPrice: 100,
    defaultGas: 1000000,
    logger: console,
});

// approve max
const maxApproveAmount = "115792089237316195423570985008687907853269984665640564039457584007913129639935";


// ABI
const moonswapPairABI = require('./pairABI.json');
const IERC20 = require('./IERC20.json');
const IERC20ABI = IERC20.abi;
const moonswapFactoryABI = require('./FactoryABI.json');
const moonswapRouterABI = require('./RouterABI.json');

// contract Address
const moonswapFactoryAddress = "0x865f55a399bf9250ae781adfbed71e70c12bd2d8";
const moonswapRouterAddress = '0x80ae6a88ce3351e9f729e8199f2871ba786ad7c5';
// pair info
const wcfxAddress = "0x8d7df9316faa0586e175b5e6d03c6bda76e3d950";  // token1
const cUSDTAddress = "0x8b8689c7f3014a4d86e4d1d0daaf74a47f5e0f27"; // token0
const productName = "CFX-USDT";


//router contract
const moonswapRouterContract = cfx.Contract({
    address: moonswapRouterAddress,
    abi: moonswapRouterABI,
})

//token contract
const wcfxContract = cfx.Contract({
    address: wcfxAddress,
    abi: IERC20ABI.abi, 
});
const cUSDTContract = cfx.Contract({
    address: cUSDTAddress,
    abi: IERC20ABI.abi, 
});

// moondex
const MatchFlowClient = require('matchflow');
const matchflow = new MatchFlowClient({ network: 'mainnet' });
const miniAmount = 0.0001;
const totalGas = 0.25;

// account private_key
const PRIVATE_KEY = '0x****************************************';  // replace your private key here, add 0x prefix
const account = cfx.wallet.addPrivateKey(PRIVATE_KEY);

// get token1 name
var token1Name, token0Name;
// total buy/sell times
var buyTimes = 0, sellTimes = 0;
// pair Address
var pairAddress;

// arbitrary json logs
var data = {
    code: 0,
    ok: true,
    beginTime: 0,
    errorTimes: 0,
    list: []
};

// statistics, usdt
var totalDexSell=0, totalDexBuy=0, totalSwapSell=0, totalSwapBuy=0;
var bestAmount=0.0, bestProfit = 0.0;
var errorTimes = 0;

async function main() {

    // record begin time
    var myDate = new Date();  
    data.beginTime = myDate.toLocaleString();

    // pre Approve
    await approveToken(cUSDTAddress, moonswapRouterAddress, account);
    await approveToken(wcfxAddress, moonswapRouterAddress, account);

    token1Name = await matchflow.currency.getTokenName(wcfxAddress);
    console.log("Token1 Name:", token1Name);
    token0Name = await matchflow.currency.getTokenName(cUSDTAddress);
    console.log("Token0 Name:", token0Name);

    pairAddress = await getPairAddress(cUSDTAddress, wcfxAddress, moonswapFactoryAddress);

    // loop arbitrary
    start();
}

async function start() {

    try {
        actionBool = await arbitrary(cUSDTAddress, wcfxAddress, token0Name, token1Name); //testAmount = 0.001
        if(actionBool) 
            timerId = setTimeout(start, 10000); //time interval, ms   
        else{
            if(data.list.length > 0) printJsonLog(); 

            timerId = setTimeout(start, 20000); //10s didn't enough for rebalance confirmed.
        }    
    } catch(err) {
        errorTimes++;
        console.log("error time(s):", errorTimes);

        var myDate = new Date();  
        console.log("Time: ", myDate.toLocaleString());

        if(data.list.length > 0) printJsonLog("_error");
        console.log(err);

        // test try again
        start();
    }
}

function printJsonLog(note = "") {
    data.errorTimes = errorTimes;
    errorTimes = 0;

    console.log(data);

    var content = JSON.stringify(data); 
    // confirm the documentary，__dirname show the name of the js's parent directory
    var timeStamp = Date.now();
    var file = path.join(__dirname, "data/arbitraryLogs" + timeStamp.toString() + note + ".json"); 

    // write file
    fs.writeFile(file, content, function(err) {
        if (err) {
            return console.log(err);
        }
        console.log("Successfully create json. Address: " + file);
    });
    // clear 
    data.list = [];
}


// strictly restricted to run ONCE before arbitrary loop.
async function approveToken(tokenAddress, allowanceAddress, account) {
    console.log("Try approve. ");
    if(tokenAddress == wcfxAddress){
        console.log("The user try to swap CFX. No need to approve.");
        return false;
    }

    tokenContract = cfx.Contract({
        address: tokenAddress,
        abi: IERC20ABI,
    });

    preAllowance = await tokenContract.allowance(account.address, allowanceAddress);
    console.log("Contract pre-approve tokens: ", preAllowance);
    swapAmount = await getSwapAccount(account, tokenAddress);

    if(BN(swapAmount).lte(BN(preAllowance))) {
        console.log("Have done Approval.");
        return false;
    }

    // to avoid ctoken balance's error(require)
    if(preAllowance > 0 ) {
        console.log("Token has approval balance. Try to mini-swap to CFX")
        await moonswapRouterContract.swapExactTokensForCFX(
            preAllowance,
            0,
            [tokenAddress, wcfxAddress],
            account.address,
            creatDeadline(),
        )
        .sendTransaction({
            from: account,
        })
        .executed();

        console.log("Mini-swap success.")
    }

    await tokenContract.approve(
        allowanceAddress,
        maxApproveAmount,
    )
    .sendTransaction({
        from: account,
    })
    .executed();

    console.log("Approve success");
    return true;
}


async function arbitrary(token0Address, token1Address, token0Name, token1Name, testAmount = 0) { //cusdt, wcfx

    var myDate = new Date();
    console.log("Start one action. Time: ", myDate.toLocaleString());

    dexDepth = await getMoonDexDepth(productName);
    buyFirst = dexDepth.Buy[0];  // first ask 
    // notice buy amount = 0.0001
    if(buyFirst.amount == miniAmount) buyFirst = dexDepth.Buy[1];

    sellFirst = dexDepth.Sell[0]; // first bid
    // notice sell amount = 0.0001
    if(sellFirst.amount == miniAmount) sellFirst = dexDepth.Sell[1];

    console.log("Dex ask %s: ", token1Name, buyFirst);
    console.log("Dex bid %s", token1Name, sellFirst);

    //pairAddress = await getPairAddress(token0Address, token1Address, moonswapFactoryAddress);
    reserves = await getPairReserves(pairAddress);
    token0Res = reserves[0]; // cUSDT, 1e18
    token1Res = reserves[1]; // wcfx, 1e18

    // estimated price
    console.log("Estimate Price:");
    eAmount = 0.1;
    sellToken1Price = getAmountOut(token1Res, token0Res, eAmount) / eAmount;
    buyToken1Price = eAmount / getAmountOut(token0Res, token1Res, eAmount);
    console.log("Swap buy %s: ", token1Name, buyToken1Price);
    console.log("Swap sell %s: ",token1Name, sellToken1Price);

    /*
    //test price
    console.log(getAmountOut(token1Res, token0Res, eAmount));
    console.log(getAmountIn(token1Res, token0Res, eAmount));
    console.log(getAmountOut(token0Res, token1Res, eAmount));
    console.log(getAmountIn(token0Res, token1Res, eAmount))
    */

    //amount become Drip
    // dex amount scale could not larger than 4
    if(buyFirst.price > buyToken1Price) {
        console.log("Buy %s from swap. Sell %s in Dex", token1Name, token1Name);

        dexPrice = buyFirst.price;
        if (testAmount > 0) maxAmount = testAmount;
        else maxAmount = buyFirst.amount;
        
        res = await buyMax(
            token0Res, 
            token1Res, 
            maxAmount, 
            dexPrice, 
            account, 
            token0Address, 
            token1Address
        ); // check whether user has enough token
        availableAmount = res.amount;
        minState = res.state;

        availableAmount = (BN(availableAmount).toNumber() - miniAmount).toFixed(4); //scale to 4
        console.log("available amount: ", availableAmount);

        tmp = getAmountIn(token0Res, token1Res, BN(availableAmount).times(BN(1e18)));
        tSwapBuy = BN(tmp).div(1e18).toNumber();
        tDexSell = availableAmount * dexPrice;

        if(availableAmount <= 0 ) { 
            console.log("Insufficient swap/dex!");
            await rebalance(token0Address, token0Name, account);
            await rebalance(token1Address, token1Name, account);
            return false;
        }
    
        /*
        // mini amount benefit, skip trading
        if((tDexSell-tSwapBuy) < dexPrice * totalGas) {
            console.log("Profit too small.");
            return true;
        }
        */

        await createLimitSellOrder(account, productName, {price: dexPrice, amount: availableAmount});
        await swapTokens(
            'Buy', 
            availableAmount, 
            dexPrice, 
            {fromAddress: token0Address, toAddress: token1Address}, 
            account
        );

        buyTimes++;

        // create record state
        state = "Buy " + token1Name + " from swap. Sell " + token1Name + " in Dex";
        totalSwapBuy += tSwapBuy;
        totalDexSell += tDexSell;
        console.log(state, totalSwapBuy, totalDexSell);

        var myDate = new Date();

        var obj = {
            time: myDate.toLocaleString(),
            state: state,
            buyPrice: BN(tmp).div(1e18).div(availableAmount).toNumber(),
            sellPrice: dexPrice,
            arbitraryAmount: availableAmount,
            bestAmount: bestAmount,
            bestProfit: bestProfit,
            dexAmount: buyFirst.amount,
            thisBuy: tSwapBuy,
            thisSell: tDexSell,
            totalDexBuy: totalDexBuy,
            totalDexSell: totalDexSell,
            totalSwapBuy: totalSwapBuy,
            totalSwapSell: totalSwapSell, 
            token0Res: token0Res,
            token1Res: token1Res,
        }
        bestAmount = 0.0;
        data.list.push(obj);

        if(minState == false) {
            await rebalance(token0Address, token0Name, account);
            await rebalance(token1Address, token1Name, account);
            return false;
        }
    }

    if(sellFirst.price < sellToken1Price) {
        console.log("Sell %s from swap, Buy %s in Dex", token1Name, token1Name);

        dexPrice = sellFirst.price;
        if(testAmount > 0 ) maxAmount = testAmount;
        else maxAmount = sellFirst.amount;

        res = await sellMax(
            token0Res, 
            token1Res, 
            maxAmount, 
            dexPrice, 
            account, 
            token0Address, 
            token1Address
        ); // check whether user has enough token
        availableAmount = res.amount;
        minState = res.state;

        availableAmount = (BN(availableAmount).toNumber() - miniAmount).toFixed(4);

        tDexBuy = availableAmount * dexPrice;
        tmp = getAmountOut(token1Res, token0Res, BN(availableAmount).times(BN(1e18)));
        tSwapSell = BN(tmp).div(1e18).toNumber();

        if(availableAmount <= 0) {  // deal with accidental error
            console.log("Insufficient swap/dex!");
            await rebalance(token0Address, token0Name, account);
            await rebalance(token1Address, token1Name, account);
            return false;
        }

        // token1 amount
        await createLimitBuyOrder(account, productName, {price: dexPrice, amount: availableAmount});
        await swapTokens(
            'Sell', 
            availableAmount, 
            dexPrice, 
            {fromAddress: token1Address, toAddress: token0Address}, 
            account
        );

        sellTimes++;

         // create record state
        state = "Sell " + token1Name + " from swap. Buy " + token1Name + " in Dex";
        totalDexBuy += tDexBuy;
        totalSwapSell += tSwapSell;
        console.log(state, totalSwapSell, totalDexBuy);

        var myDate = new Date();

        var obj = {
            time: myDate.toLocaleString(),
            state: state,
            buyPrice: dexPrice,
            sellPrice: BN(tmp).div(1e18).div(availableAmount).toNumber(),
            arbitraryAmount: availableAmount,
            bestAmount: bestAmount,
            bestProfit: bestProfit,
            dexAmount: sellFirst.amount,
            thisBuy: tDexBuy,
            thisSell: tSwapSell,
            totalDexBuy: totalDexBuy,
            totalDexSell: totalDexSell,
            totalSwapBuy: totalSwapBuy,
            totalSwapSell: totalSwapSell, 
            token0Res: token0Res,
            token1Res: token1Res,
        }
        bestAmount = 0.0;
        data.list.push(obj);

        if(minState == false) {
            await rebalance(token0Address, token0Name, account);
            await rebalance(token1Address, token1Name, account);
            return false;
        }
    }

    console.log("Finish one action. Buy %s %d time(s). Sell %s %d time(s).", token1Name, buyTimes, token1Name, sellTimes);
    return true;
}

// tool functions

// test pass
function getMin(tmax, dex, swap) {

    if(BN(tmax).lte(BN(dex)) && BN(tmax).lte(BN(swap))) {
        console.log("best Amount.");
        return {amount: BN(tmax).div(BN(1e18)).toFixed(), state: true};
    }
    else if(BN(dex).lte(BN(tmax)) && BN(dex).lte(BN(swap))) {
        console.log("dex insuffient.");
        return {amount: BN(dex).div(BN(1e18)).toFixed(), state: false};
    }
    else {
        console.log("swap insuffient.");
        return {amount: BN(swap).div(BN(1e18)).toFixed(), state: false};
    }
}

// test pass
async function createLimitBuyOrder(account, productName, {price, amount}) {
    console.log("start limit buy.");
    // Load a specific product
    const product = await matchflow.product.get(productName)

    // Get a user
    const user = await matchflow.user.get(account.address)

    // Get user accounts
    //await user.accounts().then(console.log)

    // Create a buy order
    const buyOrder = user.limitBuy(product, { price, amount });
    const result = await buyOrder.place(account);
    console.log("Finish limit buy.", JSON.stringify(result, null, 4));
}

// test pass
async function createLimitSellOrder(account, productName, {price, amount}) {
    console.log("Start limit sell.");
    // Load a specific product
    const product = await matchflow.product.get(productName)

    // Get a user
    const user = await matchflow.user.get(account.address)

    // Get user accounts
    await user.accounts().then(console.log)

    // Create a buy order
    const sellOrder = user.limitSell(product, { price, amount });
    const result = await sellOrder.place(account);
    console.log("Finish limit sell.", JSON.stringify(result, null, 4));
}

async function rebalance(tokenAddress, tokenName, account) {
    console.log("Begin rebalance %s.", tokenName);

    // balance token
    dexAccount = await getDexAccount(account, tokenAddress);
    dexAccount = BN(dexAccount).div(1e18).toNumber();
    swapAccount = await getSwapAccount(account, tokenAddress);
    swapAccount = BN(swapAccount).div(1e18).toNumber();

    balanceAmount = (dexAccount + swapAccount) / 2;
    balanceAmount = balanceAmount.toFixed(3);
    console.log("balance amount: ", balanceAmount);

    if (dexAccount < balanceAmount) {
        transferAmount = balanceAmount - dexAccount;

        await deposit(tokenName, transferAmount, account, account.address);
    }
    else if(dexAccount > balanceAmount) {
        transferAmount = dexAccount - balanceAmount;

        await withdraw(tokenName, transferAmount, account, account.address);
    }

    console.log("Finish rebalance %s.", tokenName);
    return true;
}
// test pass
async function withdraw(currencyName, amount, account, recipient) {
  
    // Load a specific currency
    const currency = await matchflow.currency.get(currencyName);
    //test
    const withdrawFee = await matchflow.currency.getWithdrawFee(currencyName);
    console.log(withdrawFee);
  
    // fetch current balance
    /*
    let balance = await currency.Contract(cfx).balanceOf(account.address);
    console.log('Balance before withdraw:', balance.toString());
    let recipientBalance = await currency.TokenContract(cfx).balanceOf(recipient);
    console.log('Recipient balance before withdraw:', recipientBalance.toString());
    */
  
    await currency.withdraw(account, recipient, amount, withdrawFee);
}

// test pass
async function deposit(currencyName, amount, account, recipient) {
    const currency = await matchflow.currency.get(currencyName);
  
    // fetch current balance 
    /*
    let balance = await currency.Contract(cfx).balanceOf(recipient);
    console.log('Balance before deposit:', balance.toString());
    let recipientBalance = await currency.TokenContract(cfx).balanceOf(account.address);
    console.log('Recipient balance before deposit:', recipientBalance.toString()); 
    */
      
    await currency.deposit(account, recipient, amount, cfx);
}

// test pass
async function getMoonDexDepth(productName) {
    const nowDepth = await matchflow.market.depth(productName);
    //test
    console.log("depth: ", nowDepth);
    // test end
    return nowDepth;
}
/*
Buy: [
    { price: 0.176, amount: 835.9488, count: 1 },
    { price: 0.175, amount: 10498.4401, count: 4 },
    { price: 0.174, amount: 4928.1609, count: 1 },
    { price: 0.173, amount: 4945.0867, count: 1 },
    { price: 0.172, amount: 5188.9535, count: 1 }
  ],
  Sell: [
    { price: 0.1819, amount: 2883.4039, count: 1 },
    { price: 0.182, amount: 2889, count: 1 },
    { price: 0.1842, amount: 0.2983, count: 1 },
    { price: 0.185, amount: 127, count: 1 },
    { price: 0.19, amount: 6680.7737, count: 3 }
  ]
*/

//test pass
async function getDexAccount(account, tokenAddress) {// cfx amount, 1e18
    console.log("getDexAccount");
    const currencyName = await matchflow.currency.getTokenName(tokenAddress);
    const user = await matchflow.user.get(account.address)
    const userInfo = await user.accounts(currencyName);
    console.log(userInfo.items);

    // pick specific currency
    tmp = lodash.pickBy(userInfo.items, (cur) => {
        return (cur.currency == currencyName);
    }); 
    currencyInfo = Object.values(tmp)[0];

    console.log("getDexAccount Success");
    return Drip.fromCFX(currencyInfo.availableString);
}
/*
{
  total: 2,
  items: [
    {
      id: 698,
      userId: 283,
      currency: 'CFX',
      hold: 0,
      available: 2.5649717514124295,
      status: 'Normal',
      balance: 2.5649717514124295,
      holdString: '0',
      availableString: '2.564971751412429378',
      balanceString: '2.564971751412429378'
    },
    {
      id: 698,
      userId: 283,
      currency: 'USDT',
      hold: 0.1,
      available: 0.29923,
      status: 'Normal',
      balance: 0.39923,
      holdString: '0.1',
      availableString: '0.299230000000000001',
      balanceString: '0.399230000000000001'
    }
  ]
}

*/

// test pass
async function getPairAddress(token0Address, token1Address, moonswapFactoryAddress) {
    //factory contract
    const factoryContract = cfx.Contract({
        address: moonswapFactoryAddress,
        abi: moonswapFactoryABI,
    });
    let moonswapPairAddress = await factoryContract.getPair(token0Address, token1Address);
    
    console.log("Successfully get pair address. Address: ", moonswapPairAddress);
    return moonswapPairAddress;
}

// test pass
async function getPairReserves(pairAddress) {
    const moonswapPairContract = cfx.Contract({
        address: pairAddress,
        abi: moonswapPairABI,
    });
    let reserves = await moonswapPairContract.getReserves();

    console.log("Successfully get pair reserves. res0: ", reserves[0], "res1: ", reserves[1]);
    return reserves;
}

// test pass
function getAmountOut(Rin, Rout, AmountIn) {
    amountInWithFee = BN(AmountIn).times(997);
    num = BN(Rout).times(amountInWithFee);
    den = BN(Rin).times(1000).plus(amountInWithFee); // use + lead to type degraded

    return num.div(den).toFixed();
}

// test pass
function getAmountIn(Rin, Rout, AmountOut) {
    if(BN(Rout).lte(BN(AmountOut))) {
        console.log("Invalid AmountOut.");
        throw new Error("Function getAmountIn Error: Invalid AmountOut.");
    }

    num = BN(Rin).times(BN(AmountOut)).times(1000);
    den = BN(Rout).minus(BN(AmountOut)).times(997);

    //return num.div(den).plus(1).toFixed();
    return num.div(den).toFixed(); //1e18
}

// test pass
async function getSwapAccount(account, tokenAddress) { // 1e18
    console.log("getSwapAccount");

    if (tokenAddress == wcfxAddress) {
        let balance = await cfx.getBalance(account.address);

        console.log("Successfully get swapAccount. Balance:", balance);
        return balance;
    }
    else {
        const tokenContract = cfx.Contract({
            address: tokenAddress,
            abi: IERC20ABI,
        });
        let balance = await tokenContract.balanceOf(account);
        
        console.log("Successfully get swapAccount. Balance: ", balance);
        return balance;
    }
}

// test pass
function findSellBest(token0Res, token1Res, dexPrice, toDripAmountIn) {
    console.log("Find sell best amount");
    k = BN(token0Res).times(BN(token1Res));
    // test
    tmp = k.times(997).times(1000).div(dexPrice).sqrt();
    tToken0num = tmp.minus(BN(token1Res).times(1000));
    tToken0 = tToken0num.div(997).times(BN(dexPrice));

    tmaxAmount = getAmountOut(token0Res, token1Res, tToken0);
    bestAmount = BN(tmaxAmount).div(BN(1e18)).toFixed();
    console.log("best amount: ", bestAmount);

    // best profit
    bestProfit = BN(tToken0).div(BN(1e18)).toNumber() - bestAmount * dexPrice;
    console.log("best profit: ", bestProfit);

    return tmaxAmount;
}

// test pass
async function sellMax(
    token0Res, //1e18
    token1Res, //1e18
    maxAmount, 
    dexPrice, 
    account, 
    token0Address, 
    token1Address) {

    toDripAmount = BN(maxAmount).times(BN(1e18));
    swapCostTokens = getAmountOut(token1Res, token0Res, toDripAmount);
    realPrice =  BN(swapCostTokens).div(BN(toDripAmount)).toFixed();
    console.log("real Price: ", realPrice, dexPrice);

    let tmaxAmount = findSellBest(token0Res, token1Res, dexPrice, toDripAmount); // 1e18
    if (BN(toDripAmount).lte(BN(tmaxAmount))) {
        tmaxAmount = toDripAmount;
        console.log("All-in available");
        bestAmount = "All-in";
        bestProfit = realPrice * maxAmount - dexPrice * maxAmount;
    }

    dexToken1Balance = await getDexAccount(account, token0Address);
    dexMaxBuy =  dexToken1Balance / dexPrice;// to 1e18

    token1Balance = await getSwapAccount(account, token1Address);
    swapMaxSell = token1Balance; //1e18
    
    console.log(tmaxAmount, dexMaxBuy, swapMaxSell);
    return getMin(tmaxAmount, dexMaxBuy, swapMaxSell); // cfx Amount
}

// test pass
function findBuyBest(token0Res, token1Res, dexPrice, toDripAmountIn) {
    console.log("Find buy best amount.");
    k = BN(token0Res).times(BN(token1Res));
    // test
    tToken0mid = k.times(997).div(1000).times(dexPrice).sqrt();
    tToken0 = tToken0mid.minus(BN(token0Res)).toFixed();

    tmaxAmount = getAmountOut(token0Res, token1Res, tToken0); //1e18
    bestAmount = BN(tmaxAmount).div(BN(1e18)).toFixed();
    console.log("best amount: ",bestAmount);

    // best profit
    bestProfit = bestAmount * dexPrice - BN(tToken0).div(BN(1e18)).toNumber();
    console.log("best profit: ", bestProfit);

    return tmaxAmount; // 1e18
} 

//test pass 
async function buyMax(
    token0Res, //1e18
    token1Res, //1e18
    maxAmount, 
    dexPrice, 
    account, 
    token0Address, 
    token1Address) {

    toDripAmount = BN(maxAmount).times(BN(1e18));
    swapCostTokens = getAmountIn(token0Res, token1Res, toDripAmount);
    realPrice =  BN(swapCostTokens).div(BN(toDripAmount)).toFixed();
    console.log("real price: ", realPrice, dexPrice);

    let tmaxAmount = findBuyBest(token0Res, token1Res, dexPrice, toDripAmount); // 1e18
    if (BN(toDripAmount).lte(BN(tmaxAmount))) {
        tmaxAmount = toDripAmount;
        console.log("All-in available");
        bestAmount = "All-in";
        bestProfit = dexPrice * maxAmount - realPrice * maxAmount;
    }

    dexMaxSell = await getDexAccount(account, token1Address); // to 1e18

    token0Balance = await getSwapAccount(account, token0Address);
    swapMaxBuy = getAmountOut(token0Res, token1Res, token0Balance); //1e18
    
    return getMin(tmaxAmount, dexMaxSell, swapMaxBuy); // cfx Amount
}

async function swapTokens(
    side, // buy or sell 
    amount, 
    priceControl, // profit limit
    {fromAddress, toAddress},  // approve exact tokens
    account) {
    
    console.log("Begin swap tokens");
    if (side == 'Sell') {
        if(fromAddress == wcfxAddress) {
            // direct send transaction
            await moonswapRouterContract.swapExactCFXForTokens(
                BN(amount).times(BN(priceControl)).times(BN(1e18)).toString(), // price control
                [fromAddress, toAddress],
                account.address,
                creatDeadline(),
            )
            .sendTransaction({
                from: account,
                to: moonswapRouterAddress,
                value: BN(amount).times(BN(1e18)).toString()
            })
            .executed();
          
        }
        else{
            await moonswapRouterContract.swapExactTokensForTokens(
                BN(amount).times(BN(1e18)).toString(),
                BN(priceControl).times(BN(amount)).times(BN(1e18)).toString(), //price controll
                [fromAddress, toAddress],
                account.address,
                creatDeadline(),
            )
            .sendTransaction({
                from: account,
            })
            .executed();
        }
    }
    else if (side == 'Buy') {

        if(toAddress == wcfxAddress) {
            
            console.log(amount, priceControl*amount);
            await moonswapRouterContract.swapTokensForExactCFX(
                BN(amount).times(BN(1e18)).toString(),
                BN(priceControl).times(BN(amount).times(BN(1e18))).toString(), //price controll
                [fromAddress, toAddress],
                account.address,
                creatDeadline(),
            )
            .sendTransaction({
                from: account,
            })
            .executed();

        }
        else {

            await moonswapRouterContract.swapTokensForExactTokens(
                BN(amount).times(BN(1e18)).toString(),
                BN(priceControl).times(BN(amount).times(BN(1e18))).toString(), //price controll
                [fromAddress, toAddress],
                account.address,
                creatDeadline(),
            )
            .sendTransaction({
                from: account,
            })
            .executed();
    
        }
    }
    else {
        throw new error("Invalid method");
    }

    console.log("Finish swap tokens");
}

// test pass
function creatDeadline() {
    console.log("deadline test: ", Math.floor(Date.now() / 1000) + 20);
    return Math.floor(Date.now() / 1000) + 20;
}

main().catch(e => console.error(e));
