/* eslint-env jest */
import Vue from 'vue'
import Vuex from 'vuex'
import axios from 'axios'
import { RpcFetcher } from '@tornado/gas-price-oracle/lib/services/rpcFetcher'
import { parseUnits } from 'ethers/lib/utils'
import networkConfig from '@/networkConfig'
import { relayerRegisterService } from '@/services'
import application from '@/store/application'
import * as fees from '@/store/fees'
import * as relayer from '@/store/relayer'

jest.mock('axios', () => ({ ...jest.requireActual('axios'), get: jest.fn() }))
jest.mock('@/utils', () => ({
  ...jest.requireActual('@/utils/storeUtils'),
  ...jest.requireActual('@/utils/stringUtils')
}))
jest.mock('@/services', () => ({
  schema: jest.requireActual('@/services/schema').default,
  relayerRegisterService: jest.fn()
}))
Vue.use(Vuex)
afterEach(() => jest.restoreAllMocks())

function makeStore(netId = 1) {
  const config = networkConfig[`netId${netId}`]
  const rpcSettings = { rpc: { url: 'http://rpc.invalid' } }
  const store = new Vuex.Store({
    state: { settings: { netId1: rpcSettings, [`netId${netId}`]: rpcSettings }, price: { prices: {} } },
    getters: {
      'metamask/netId': () => netId,
      'metamask/networkConfig': () => config,
      'metamask/nativeCurrency': () => config.nativeCurrency
    },
    modules: {
      application,
      fees: { namespaced: true, ...fees },
      relayer: { namespaced: true, ...relayer },
      notice: { namespaced: true, actions: { addNotice: jest.fn() } }
    }
  })
  store.app = { i18n: { t: (key) => key } }
  return store
}

function status(version, netId = 1) {
  const { nativeCurrency, tokens } = networkConfig[`netId${netId}`]
  return {
    version,
    netId,
    currentQueue: 0,
    tornadoServiceFee: 0.4,
    rewardAccount: '0x0000000000000000000000000000000000000001',
    instances: { [nativeCurrency]: tokens[nativeCurrency] },
    ethPrices: { dai: '1', cdai: '1', usdc: '1', usdt: '1', torn: '1', wbtc: '1' },
    health: { status: 'true' }
  }
}

test.each([
  [1, '4.1.6', ['4.1.7', '4.1.10', '4.2.0'], ['4.0.99', '4.2.0-rc.1', '5.0.0']],
  [56, '5.2.2', ['5.2.3', '5.2.10', '5.3.0'], ['5.1.99', '5.3.0-rc.1', '4.1.7', '6.0.0']]
])('network %i filters relayers and clears outdated selections', async (netId, old, valid, invalid) => {
  const store = makeStore(netId)
  const versions = [old, ...valid, ...invalid]
  const registered = versions.map((version, i) => ({
    hostname: `r${i}.invalid`,
    ensName: version,
    stakeBalance: '1'
  }))
  relayerRegisterService.mockReturnValue({ getRelayers: jest.fn().mockResolvedValue(registered) })
  axios.get.mockImplementation((url) => {
    const endpoint = registered.find((r) => r.hostname === new URL(url).hostname)
    return Promise.resolve({ data: status(endpoint.ensName, netId) })
  })
  await store.dispatch('relayer/pickRandomRelayer')
  expect(store.state.relayer.validRelayers.map((r) => r.name).sort()).toEqual([...valid].sort())
  expect(valid).toContain(store.state.relayer.selectedRelayer.name)
  axios.get.mockResolvedValue({ data: status(old, netId) })
  await store.dispatch('relayer/pickRandomRelayer')
  expect(store.state.relayer.validRelayers).toEqual([])
  expect(store.state.relayer.selectedRelayer.name).toBeFalsy()
})

test('Sepolia continues accepting a stable 5.x relayer', async () => {
  axios.get.mockResolvedValue({ data: status('5.0.0', 11155111) })
  const result = await makeStore(11155111).dispatch('relayer/askRelayerStatus', { hostname: 'relay.invalid' })
  expect(result.isValid).toBe(true)
})

function makeQuoteStore(tip, netId = 1) {
  const priority = parseUnits(tip, 'gwei').toHexString()
  const results = {
    eth_getBlockByNumber: { baseFeePerGas: parseUnits('2', 'gwei').toHexString() },
    eth_maxPriorityFeePerGas: priority,
    eth_feeHistory: { reward: [[priority]] }
  }
  jest.spyOn(RpcFetcher.prototype, 'makeRpcCall').mockImplementation(({ method }) => {
    if (!(method in results)) throw new Error('Unexpected RPC method ' + method)
    return Promise.resolve({ data: { result: results[method] } })
  })
  const store = makeStore(netId)
  store.commit('relayer/SET_SELECTED_RELAYER', { name: 'test-relayer', tornadoServiceFee: 0.4 })
  return store
}

test.each([
  [1, '0.1', '0.3', '2.3'],
  [1, '10', '10', '12'],
  [56, '0.1', '0.33', '2.53'],
  [56, '1', '1.1', '3.3'],
  [137, '0.01', '0.065', '2.665']
])(
  'network %s quotes a %s gwei tip through the shared wallet and withdrawal oracle',
  async (netId, tip, expectedPriority, expectedGasPrice) => {
    const store = makeQuoteStore(tip, netId)
    const currency = store.getters['metamask/nativeCurrency']
    store.commit('application/SET_SELECTED_STATISTIC', { currency, amount: 1 })
    const oracle = store.getters['fees/oracle']
    const params = await oracle.getGasPriceParams()
    expect(BigInt(params.maxPriorityFeePerGas)).toBe(parseUnits(expectedPriority, 'gwei').toBigInt())
    store.commit('fees/SAVE_GAS_PARAMS', params)
    expect(Number(store.getters['fees/gasPriceInGwei'])).toBe(Number(expectedGasPrice))
    await store.dispatch('fees/calculateWithdrawalFeeViaRelayer', {})
    const gasLimit = await oracle.getGasLimit(undefined, 'user_withdrawal')
    const networkFee = parseUnits(expectedGasPrice, 'gwei').mul(gasLimit)
    expect(store.state.fees.withdrawalNetworkFee.toString()).toBe(networkFee.toString())
    expect(store.state.fees.withdrawalFeeViaRelayer.toString()).toBe(
      networkFee.add(parseUnits('0.004', 18)).toString()
    )
  }
)

test.each([
  ['dai', 100, 18, '0.0005', 55000],
  ['wbtc', 1, 8, '30', 85000]
])(
  '%s calculates the ETH recommendation and token conversion using the shared gas quote',
  async (currency, amount, decimals, price, tokenGas) => {
    const store = makeQuoteStore('0.1')
    store.commit('application/SET_SELECTED_STATISTIC', { currency, amount })
    const weiPerToken = parseUnits(price, 18)
    store.state.price.prices[currency] = weiPerToken.toString()
    await store.dispatch('fees/calculateWithdrawalFeeViaRelayer', {})
    const refund = parseUnits('2.3', 'gwei').mul(2 * tokenGas)
    expect(BigInt(store.state.application.ethToReceive)).toBe(refund.toBigInt())
    const networkFee = parseUnits('2.3', 'gwei').mul(550000)
    const gasAndRefundInToken = networkFee
      .add(refund)
      .mul(parseUnits('1', decimals))
      .div(weiPerToken)
    const serviceFee = parseUnits(String(amount), decimals)
      .mul(4)
      .div(1000)
    expect(store.state.fees.withdrawalFeeViaRelayer.toString()).toBe(
      gasAndRefundInToken.add(serviceFee).toString()
    )
  }
)
