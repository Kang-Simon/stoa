import {
    Amount,
    Block,
    BlockHeader,
    Endian,
    Hash,
    hash,
    hashFull,
    Height,
    JSBI,
    LockType,
    PreImageInfo,
    PublicKey,
    Signature,
    Transaction,
    TxInput,
    Utils,
} from "boa-sdk-ts";
import bodyParser from "body-parser";
import cors from "cors";
import express from "express";
import lodash from "lodash";
import moment from "moment";
import responseTime from "response-time";
import { Socket } from "socket.io";
import { URL } from "url";
import { isBlackList } from "../src/modules/middleware/blacklistMiddleware";
import { cors_options, cors_private_options } from "./cors";
import { AgoraClient } from "./modules/agora/AgoraClient";
import { IDatabaseConfig } from "./modules/common/Config";
import { Exchange } from "./modules/common/Exchange";
import { FeeManager } from "./modules/common/FeeManager";
import { HeightManager } from "./modules/common/HeightManager";
import { logger } from "./modules/common/Logger";
import { Operation, Status } from "./modules/common/LogOperation";
import { mailService } from "./modules/common/Mailer";
import { Time } from "./modules/common/Time";
import events from "./modules/events/events";
import "./modules/events/handlers";
import { CoinMarketService } from "./modules/service/CoinMarketService";
import { NodeService } from "./modules/service/NodeService";
import { VoteraService } from "./modules/service/VoteraService";
import { WebService } from "./modules/service/WebService";
import { LedgerStorage } from "./modules/storage/LedgerStorage";
import { WalletWatcherIO } from "./modules/wallet/WalletWatcherIO";
import {
    ConvertTypes,
    CurrencyType,
    DisplayTxType,
    IAccountChart,
    IAvgFee,
    IBallotAPI,
    IBlock,
    IBlockEnrollment,
    IBlockOverview,
    IBlockTransactions,
    IBlockValidator,
    IBOAHolder,
    IBOAStats,
    IEmitBlock,
    IEmitTransaction,
    IMarketCap,
    IMarketChart,
    IPagination,
    IPendingProposal,
    IPendingTxs,
    IPreimage,
    IProposalAPI,
    IProposalList,
    ISPVStatus,
    ITransaction,
    ITransactionFee,
    ITransactionsAddress,
    ITxAddressInputElement,
    ITxAddressOutputElement,
    ITxDetail,
    ITxHistory,
    ITxHistoryElement,
    ITxHistoryHeader,
    ITxHistoryItem,
    ITxOverview,
    ITxStatus,
    IUnspentTxOutput,
    IValidatorReward,
    IVotingDetails,
    ValidatorData,
} from "./Types";

class Stoa extends WebService {
    private _ledger_storage: LedgerStorage | null;

    /**
     * Network client to interact with Agora
     */
    private readonly agora: AgoraClient;
    /**
     * Stoa page size limit
     */
    private readonly limit_page_size: number = 100;

    /**
     * Instance of coin Market for stoa
     */
    public coinMarketService: CoinMarketService | undefined;

    /**
     * Chain of pending store operations
     *
     * To ensure swift response time to Agora when our handlers are called,
     * we start the storage asynchronously and respond immediately with HTTP/200.
     * This means that if we get called in a quick succession, we need to make sure
     * the data is processed serially. To do so, we chain `Promise`s in this member.
     */
    private pending: Promise<void>;

    /**
     * The maximum number of blocks that can be recovered at one time
     */
    private _max_count_on_recovery: number = 64;

    /**
     * The Database config
     */
    private databaseConfig: IDatabaseConfig;

    /**
     * The Votera endpoint
     */
    public voteraService?: VoteraService | undefined;

    /**
     * The node service instance
     */
    public node_Service?: NodeService;

    /**
     * The genesis timestamp
     */
    private readonly genesis_timestamp: number;

    /**
     * The block interval
     */
    private readonly block_interval: number;

    /**
     * excluded addresses
     */
    private readonly excluded_addresses?: string[];

    /**
     * The cycle length for a validator
     */
    private readonly validator_cycle: number;

    private wallet_watcher: WalletWatcherIO;

    /**
     * Constructor
     * @param databaseConfig Mysql database configuration
     * @param agora_endpoint The network endpoint to connect to Agora
     * @param port The network port of Stoa
     * @param address The network address of Stoa
     * @param genesis_timestamp The genesis timestamp
     */
    constructor(
        databaseConfig: IDatabaseConfig,
        agora_endpoint: URL,
        port: number | string,
        private_port: number | string,
        address: string,
        ssl_certificate: string,
        ssl_certificate_key: string,
        genesis_timestamp: number,
        block_interval: number,
        validator_cycle: number,
        votera_service?: VoteraService,
        coinMarketService?: CoinMarketService,
        nodeService?: NodeService,
        excluded_addresses?: string[]
    ) {
        super(port, private_port, address, ssl_certificate, ssl_certificate_key);

        this.genesis_timestamp = genesis_timestamp;
        this.block_interval = block_interval;
        this.validator_cycle = validator_cycle;
        this._ledger_storage = null;
        this.databaseConfig = databaseConfig;
        this.coinMarketService = coinMarketService;
        this.voteraService = votera_service;
        this.node_Service = nodeService;
        this.excluded_addresses = excluded_addresses;
        this.wallet_watcher = new WalletWatcherIO();

        // Instantiate a dummy promise for chaining
        this.pending = new Promise<void>(function (resolve, reject): void {
            resolve();
        });
        // Do this last, as it is possible it will fail, and we only want failure
        // to happen after we checked that our own state is correct.
        this.agora = new AgoraClient(agora_endpoint);
    }

    /**
     * Creates a instance of LedgerStorage
     */
    public createStorage(): Promise<void> {
        return LedgerStorage.make(
            this.databaseConfig,
            this.genesis_timestamp,
            this.block_interval,
            this.validator_cycle,
            this.excluded_addresses
        ).then((storage) => {
            this._ledger_storage = storage;
        });
    }

    /**
     * Returns the instance of LedgerStorage
     * This must be invoked after creating an instance of
     * `LedgerStorage` using `createStorage`.
     * @returns If `_ledger_storage` is not null, return `_ledger_storage`.
     * Otherwise, terminate the process.
     */
    public get ledger_storage(): LedgerStorage {
        if (this._ledger_storage !== null) return this._ledger_storage;
        else {
            logger.error("LedgerStorage is not ready yet.", {
                operation: Operation.start,
                height: "",
                status: Status.Error,
                responseTime: Number(moment().utc().unix() * 1000),
            });
            process.exit(1);
        }
    }

    /**
     * Setup and start the server
     */
    public async start(): Promise<void> {
        // Prepare middleware

        // parse application/x-www-form-urlencoded
        this.app.use(bodyParser.urlencoded({ extended: false, limit: "1mb" }));
        this.private_app.use(bodyParser.urlencoded({ extended: false, limit: "10mb" }));

        // parse application/json
        this.app.use(bodyParser.json({ limit: "1mb" }));
        this.private_app.use(bodyParser.json({ limit: "10mb" }));
        this.app.use(cors(cors_options));
        this.private_app.use(cors(cors_private_options));

        this.app.use(
            responseTime((req: any, res: any, time: any) => {
                logger.http(`${req.method} ${req.url}`, {
                    endpoint: req.url,
                    RequesterIP: req.headers['x-forwarded-for'] === undefined ? req.ip : req.headers['x-forwarded-for'],
                    protocol: req.protocol,
                    httpStatusCode: res.statusCode,
                    userAgent: req.headers["user-agent"],
                    status: res.statusCode !== 200 ? "Denied" : "Granted",
                    bytesTransmitted: res.socket?.bytesWritten,
                    time: `${time / 1000} seconds`,
                    responseTime: Number(moment().utc().unix() * 1000),
                    height: HeightManager.height.toString(),
                    operation: Operation.Http_request,
                });
            })
        );

        this.private_app.use(
            responseTime((req: any, res: any, time: any) => {
                logger.http(`${req.method} ${req.url}`, {
                    endpoint: req.url,
                    RequesterIP: req.headers['x-forwarded-for'] === undefined ? req.ip : req.headers['x-forwarded-for'],
                    protocol: req.protocol,
                    httpStatusCode: res.statusCode,
                    userAgent: req.headers["user-agent"],
                    status: res.statusCode !== 200 ? "Denied" : "Granted",
                    bytesTransmitted: res.socket?.bytesWritten,
                    time: `${time / 1000} seconds`,
                    height: HeightManager.height.toString(),
                    operation: Operation.Http_request,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
            })
        );

        // Prepare routes
        this.app.get("/block_height", isBlackList, this.getBlockHeight.bind(this));
        this.app.get("/block_height_at/:time", isBlackList, this.getBlockHeightAt.bind(this));
        this.app.get("/validators", isBlackList, this.getValidators.bind(this));
        this.app.get("/validator/:address", isBlackList, this.getValidator.bind(this));
        this.app.get("/transaction/pending/:hash", isBlackList, this.getTransactionPending.bind(this));
        this.app.get("/transaction/:hash", isBlackList, this.getTransaction.bind(this));
        this.app.get("/utxo/:address", isBlackList, this.getUTXO.bind(this));
        this.app.post("/utxos", isBlackList, this.getUTXOs.bind(this));
        this.app.get("/transaction/status/:hash", isBlackList, this.getTransactionStatus.bind(this));
        this.app.get("/transaction/fees/:tx_size", isBlackList, this.getTransactionFees.bind(this));
        this.app.get("/transactions/address/:address", isBlackList, this.getTransactionsAddress.bind(this));
        this.app.get(
            "/wallet/transactions/history/:address",
            isBlackList,
            this.getWalletTransactionsHistory.bind(this)
        );
        this.app.get("/wallet/transaction/history/:address", isBlackList, this.getWalletTransactionHistory.bind(this));
        this.app.get("/wallet/transaction/overview/:hash", isBlackList, this.getWalletTransactionOverview.bind(this));
        this.app.get("/transaction/pending/overview/:hash", isBlackList, this.getWalletPendingTransactionOverview.bind(this));
        this.app.get("/wallet/transaction/detail/:hash", isBlackList, this.getWalletTransactionDetail.bind(this));
        this.app.get(
            "/wallet/transactions/pending/:address",
            isBlackList,
            this.getWalletTransactionsPending.bind(this)
        );
        this.app.get("/wallet/balance/:address", isBlackList, this.getWalletBalance.bind(this));
        this.app.get("/wallet/utxo/:address", isBlackList, this.getWalletUTXO.bind(this));
        this.app.get("/wallet/blocks/header", isBlackList, this.getWalletBlocksHeader.bind(this));
        this.app.get("/latest-blocks", isBlackList, this.getLatestBlocks.bind(this));
        this.app.get("/latest-transactions", isBlackList, this.getLatestTransactions.bind(this));
        this.app.get("/block-summary", isBlackList, this.getBlockSummary.bind(this));
        this.app.get("/block-enrollments", isBlackList, this.getBlockEnrollments.bind(this));
        this.app.get("/block-transactions", isBlackList, this.getBlockTransactions.bind(this));
        this.app.get("/boa-stats", isBlackList, this.getBOAStats.bind(this));
        this.app.get("/spv/:hash", isBlackList, this.verifyPayment.bind(this));
        this.app.get("/coinmarketcap", isBlackList, this.getCoinMarketCap.bind(this));
        this.app.get("/coinmarketchart", isBlackList, this.getBoaPriceChart.bind(this));
        this.app.get("/holders", isBlackList, this.getBoaHolders.bind(this));
        this.app.get("/holder_balance_history/:address", isBlackList, this.getHolderBalanceHistory.bind(this));
        this.app.get("/holder/:address", isBlackList, this.getBoaHolder.bind(this));
        this.app.get("/average_fee_chart", isBlackList, this.averageFeeChart.bind(this));
        this.app.get("/search/hash/:hash", isBlackList, this.searchHash.bind(this));
        this.app.get("/proposals/", isBlackList, this.getProposals.bind(this));
        this.app.get("/proposal/:proposal_id", isBlackList, this.getProposalById.bind(this));
        this.app.get("/proposal/voting-details/:proposal_id", isBlackList, this.getVotingDetails.bind(this));
        this.app.get("/validator/reward/:address", isBlackList, this.getValidatorReward.bind(this));
        this.app.get("/validator/ballot/:address", isBlackList, this.getValidatorBallots.bind(this));
        this.app.get("/convert-to-currency", isBlackList, this.convertToCurrency.bind(this));
        this.app.get("/txhash/:utxo", isBlackList, this.getTransactionHash.bind(this));
        this.app.get("/validator/missed-blocks/:address", isBlackList, this.getValidatorMissedBlocks.bind(this));
        this.app.get("/block/validators", isBlackList, this.getBlockValidators.bind(this));


        // It operates on a private port
        this.private_app.post("/block_externalized", this.postBlock.bind(this));
        this.private_app.post("/block_header_updated", this.postBlockHeaderUpdate.bind(this));
        this.private_app.post("/preimage_received", this.putPreImage.bind(this));
        this.private_app.post("/transaction_received", this.putTransaction.bind(this));

        const height: Height = new Height("0");
        await HeightManager.init(this);

        // Start the server once we can establish a connection to Agora
        return this.agora
            .getBlockHeight()
            .then(
                async (res) => {
                    height.value = JSBI.BigInt(res.value);
                    logger.info(`Connected to Agora, block height is ${res.toString()}`, {
                        operation: Operation.connection,
                        height: HeightManager.height.toString(),
                        status: Status.Success,
                        responseTime: Number(moment().utc().unix() * 1000),
                    });
                    return super.start();
                },
                (err) => {
                    mailService.mailer(Operation.connection, err);
                    logger.error(`Error: Could not connect to Agora node: ${err.toString()}`, {
                        operation: Operation.connection,
                        height: HeightManager.height.toString(),
                        status: Status.Error,
                        responseTime: Number(moment().utc().unix() * 1000),
                    });
                    process.exit(1);
                }
            )
            .then(() => {
                if (this.coinMarketService !== undefined)
                    this.coinMarketService.start(this).catch(async (err) => {
                        mailService.mailer(Operation.connection, err)
                        logger.error(`Error: Could not connect to marketcap Client: ${err.toString()}`, {
                            operation: Operation.connection,
                            height: HeightManager.height.toString(),
                            status: Status.Error,
                            responseTime: Number(moment().utc().unix() * 1000),
                        });
                    });
                if (this.voteraService !== undefined) {
                    this.voteraService?.start(this).catch((err) => {
                        mailService.mailer(Operation.connection, err)
                        logger.error(`Error: Could not connect to votera : ${err.toString()}`, {
                            operation: Operation.connection,
                            height: HeightManager.height.toString(),
                            status: Status.Error,
                        });
                    });
                }
                this.node_Service?.start(this).catch((err) => {
                    mailService.mailer(Operation.connection, err)
                    logger.error(`Error: Could not connect to node : ${err.toString()}`, {
                        operation: Operation.connection,
                        height: HeightManager.height.toString(),
                        status: Status.Error,
                    });
                });
                this.socket.io.on(events.client.connection, (socket: Socket) => {
                    this.eventDispatcher.dispatch(events.client.connection, socket);
                    this.wallet_watcher.onClientConnected(socket);
                });
                return (this.pending = this.pending.then(() => {
                    return this.catchup(height);
                }));
            });
    }

    /**
     * GET /validators
     *
     * Called when a request is received through the `/validators` handler
     *
     * Returns a set of Validators based on the block height if there is a height.
     * If height was not provided the latest validator set is returned.
     */
    private async getValidators(req: express.Request, res: express.Response) {
        if (req.query.height !== undefined && !Utils.isPositiveInteger(req.query.height.toString())) {
            res.status(400).send(`Invalid value for parameter 'height': ${req.query.height.toString()}`);
            return;
        }

        const height = req.query.height !== undefined ? new Height(req.query.height.toString()) : null;

        if (height != null)
            logger.http(`GET /validators height=${height.toString()}`, {
                operation: Operation.Http_request,
                height: HeightManager.height.toString(),
                status: Status.Error,
                responseTime: Number(moment().utc().unix() * 1000),
            });
        let pageSize: number | undefined;
        let page: number | undefined;
        if (req.query.pageSize !== undefined && req.query.page !== undefined) {
            const pagination: IPagination = await this.paginate(req, res);
            pageSize = pagination.pageSize;
            page = pagination.page
        }
        else {
            pageSize = undefined;
            page = undefined;
        }
        this.ledger_storage
            .getValidatorsAPI(height, null, undefined, pageSize,
                page)
            .then((rows: any[]) => {
                // Nothing found
                if (!rows.length) {
                    if (height !== null) res.status(204).send("No validator exists for block height.");
                    else res.status(503).send("Stoa is currently unavailable.");

                    return;
                }

                const out_put: ValidatorData[] = new Array<ValidatorData>();

                for (const row of rows) {
                    const preimage_hash: string =
                        row.preimage_hash !== null ? new Hash(row.preimage_hash, Endian.Little).toString() : "";
                    const preimage_height_str: string =
                        row.preimage_height !== null ? row.preimage_height.toString() : "";

                    const preimage: IPreimage = {
                        height: preimage_height_str,
                        hash: preimage_hash,
                    };

                    const validator: ValidatorData = new ValidatorData(
                        row.address,
                        new Height(JSBI.BigInt(row.enrolled_at)),
                        new Hash(row.stake, Endian.Little).toString(),
                        row.full_count,
                        row.slashed ? row.slashed : 0,
                        '',
                        row.stake_amount,
                        row.block_height,
                        preimage,
                    );
                    out_put.push(validator);
                }
                res.status(200).send(JSON.stringify(out_put));
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /validator/:address
     *
     * Called when a request is received through the `/validators/:address` handler
     *
     * Returns a set of Validators based on the block height if there is a height.
     * If height was not provided the latest validator set is returned.
     * If an address was provided, return the validator data of the address if it exists.
     */
    private getValidator(req: express.Request, res: express.Response) {
        if (req.query.height !== undefined && !Utils.isPositiveInteger(req.query.height.toString())) {
            res.status(400).send(`Invalid value for parameter 'height': ${req.query.height.toString()}`);
            return;
        }

        const height = req.query.height !== undefined ? new Height(req.query.height.toString()) : null;

        const address: string = String(req.params.address);

        if (height != null)
            logger.http(`GET /validator/${address} height=${height.toString()}`, {
                operation: Operation.connection,
                height: HeightManager.height.toString(),
                status: Status.Error,
                responseTime: Number(moment().utc().unix() * 1000),
            });

        this.ledger_storage
            .getValidatorsAPI(height, address)
            .then((rows: any[]) => {
                // Nothing to show
                if (!rows.length) {
                    res.status(204).send(
                        `The validator data not found.` + `'address': (${address}), 'height': (${height?.toString()})`
                    );
                    return;
                }

                const out_put: ValidatorData[] = new Array<ValidatorData>();

                if (rows.length > 0) {
                    const row = rows[0];
                    const preimage_hash: string =
                        row.preimage_hash !== null ? new Hash(row.preimage_hash, Endian.Little).toString() : "";
                    const preimage_height_str: string =
                        row.preimage_height !== null ? row.preimage_height.toString() : "";

                    const preimage: IPreimage = {
                        height: preimage_height_str,
                        hash: preimage_hash,
                    };

                    const validator: ValidatorData = new ValidatorData(
                        row.address,
                        new Height(JSBI.BigInt(row.enrolled_at)),
                        new Hash(row.stake, Endian.Little).toString(),
                        row.full_count,
                        row.slashed ? row.slashed : 0,
                        '',
                        row.stake_amount,
                        row.block_height,
                        preimage,
                    );
                    out_put.push(validator);
                }
                res.status(200).send(JSON.stringify(out_put));
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /transaction/status/:hash
     *
     * Called when a request is received through the `/transaction/status/:hash` handler
     * The parameter `hash` is the hash of the transaction
     *
     * Returns a transaction status.
     */
    private getTransactionStatus(req: express.Request, res: express.Response) {
        const req_hash: string = String(req.params.hash);

        let tx_hash: Hash;
        try {
            tx_hash = new Hash(req_hash);
        } catch (error) {
            res.status(400).send(`Invalid value for parameter 'hash': ${hash}`);
            return;
        }

        this.ledger_storage
            .getTransactionStatus(tx_hash)
            .then((data: any) => {
                const status: ITxStatus = {
                    status: data.status,
                    tx_hash: new Hash(data.tx_hash, Endian.Little).toString(),
                };
                if (data.block !== undefined) {
                    status.block = {
                        height: data.block.height,
                        hash: new Hash(data.block.hash, Endian.Little).toString(),
                    };
                }
                res.status(200).send(JSON.stringify(status));
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /transaction/fees/:tx_size
     *
     * Called when a request is received through the `/transaction/fees/:tx_size` handler
     *
     * Returns transaction fees by the transaction size.
     */
    private getTransactionFees(req: express.Request, res: express.Response) {
        const size: string = req.params.tx_size.toString();
        let currency: string;
        if (req.query.currency === undefined) {
            currency = CurrencyType.USD;
        } else {
            currency = String(req.query.currency);
        }
        if (!Utils.isPositiveInteger(size)) {
            res.status(400).send(`Invalid value for parameter 'tx_size': ${size}`);
            return;
        }
        const tx_size = Number(size);
        const block_height = HeightManager.height.toString();

        this.ledger_storage
            .getFeeMeanDisparity(Number(block_height))
            .then(async (value: any) => {
                const fees = FeeManager.getTxFee(tx_size, value.disparity);
                let exchangeRate = await this.ledger_storage.getExchangeRate(currency);
                let exchange = new Exchange(exchangeRate);
                const data: ITransactionFee = {
                    tx_size,
                    high: fees[0].toString(),
                    high_currency: exchange.convertAmountToCurrency(new Amount(Number(fees[0].toString()))),
                    high_delay: value.high_delay ? value.high_delay : undefined,
                    medium: fees[1].toString(),
                    medium_currency: exchange.convertAmountToCurrency(new Amount(Number(fees[1].toString()))),
                    medium_delay: value.medium_delay ? value.medium_delay : undefined,
                    low: fees[2].toString(),
                    low_currency: exchange.convertAmountToCurrency(new Amount(Number(fees[2].toString()))),
                    low_delay: value.low_delay ? value.low_delay : undefined,
                };
                res.status(200).send(JSON.stringify(data));
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /transactions/address/:address
     *
     * Called when a request is received through the `/transactions/address/:address` handler
     * The parameter `address` is the address
     *
     * @returns Returns transactions of block.
     */
    private async getTransactionsAddress(req: express.Request, res: express.Response) {
        const address = req.params.address.toString();
        if (PublicKey.validate(address) !== "") {
            res.status(400).send(`Invalid value for parameter 'address': ${address}`);
            return;
        }

        const pagination: IPagination = await this.paginate(req, res);
        this.ledger_storage
            .getTransactionsAddress(address, pagination.pageSize, pagination.page)
            .then((data: any[]) => {
                if (data === undefined) {
                    res.status(500).send("Failed to data lookup");
                    return;
                } else {
                    const txs: ITransactionsAddress[] = [];
                    for (const row of data) {
                        const tx: ITransactionsAddress = {
                            height: JSBI.BigInt(row.block_height).toString(),
                            tx_hash: new Hash(row.tx_hash, Endian.Little).toString(),
                            type: lodash.capitalize(ConvertTypes.TxTypeToString(row.type)),
                            fee: row.tx_fee,
                            size: row.tx_size,
                            time: row.time_stamp,
                            inputs: [],
                            outputs: [],
                            full_count: row.full_count,
                        };

                        if (row.inputs && row.inputs.length > 0)
                            for (const elem of row.inputs)
                                tx.inputs.push({
                                    address: elem.address,
                                    amount: elem.amount,
                                });
                        if (row.outputs && row.outputs.length > 0)
                            for (const elem of row.outputs)
                                tx.outputs.push({
                                    type: elem.type,
                                    address: elem.address,
                                    amount: elem.amount,
                                });
                        txs.push(tx);
                    }
                    return res.status(200).send(JSON.stringify(txs));
                }
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.Http_request,
                    height: "",
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /transaction/pending/:hash
     *
     * Called when a request is received through the `/transaction/pending/:hash` handler
     *
     * Returns a pending transaction by the transaction hash.
     */
    private getTransactionPending(req: express.Request, res: express.Response) {
        const req_hash: string = String(req.params.hash);

        let tx_hash: Hash;
        try {
            tx_hash = new Hash(req_hash);
        } catch (error) {
            res.status(400).send(`Invalid value for parameter 'hash': ${hash}`);
            return;
        }

        this.ledger_storage
            .getTransactionPending(tx_hash)
            .then((tx) => {
                if (tx === null) {
                    res.status(204).send(`No pending transactions. hash': (${hash})`);
                    return;
                }

                res.status(200).send(JSON.stringify(tx));
            })
            .catch((err) => {

                mailService.mailer(Operation.db, err);
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /transaction/:hash
     *
     * Called when a request is received through the `/transaction/:hash` handler
     *
     * Returns a transaction by the transaction hash.
     */
    private getTransaction(req: express.Request, res: express.Response) {
        const req_hash: string = String(req.params.hash);

        let tx_hash: Hash;
        try {
            tx_hash = new Hash(req_hash);
        } catch (error) {
            res.status(400).send(`Invalid value for parameter 'hash': ${hash}`);
            return;
        }

        this.ledger_storage
            .getTransaction(tx_hash)
            .then((tx) => {
                if (tx === null) {
                    res.status(204).send(`No transactions. hash': (${hash})`);
                    return;
                }

                res.status(200).send(JSON.stringify(tx));
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /utxo/:address
     *
     * Called when a request is received through the `/utxo/:address` handler
     *
     * Returns a set of UTXOs of the address.
     */
    private getUTXO(req: express.Request, res: express.Response) {
        const address: string = String(req.params.address);

        this.ledger_storage
            .getUTXO(address)
            .then((rows: any[]) => {
                const utxo_array: IUnspentTxOutput[] = [];
                for (const row of rows) {
                    const utxo = {
                        utxo: new Hash(row.utxo, Endian.Little).toString(),
                        type: row.type,
                        unlock_height: JSBI.BigInt(row.unlock_height).toString(),
                        amount: JSBI.BigInt(row.amount).toString(),
                        height: JSBI.BigInt(row.block_height).toString(),
                        time: row.block_time,
                        lock_type: row.lock_type,
                        lock_bytes: row.lock_bytes.toString("base64"),
                    };
                    utxo_array.push(utxo);
                }
                res.status(200).send(JSON.stringify(utxo_array));
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * POST /utxos
     *
     * Called when a request is received through the `/utxos/` handler
     *
     * Returns UTXO's information about the UTXO hash array.
     */
    private getUTXOs(req: express.Request, res: express.Response) {
        if (req.body.utxos === undefined) {
            res.status(400).send({
                statusMessage: "Missing 'utxos' object in body",
            });
            return;
        }

        let utxos_hash: Hash[];
        try {
            utxos_hash = req.body.utxos.map((m: string) => new Hash(m));
        } catch (error) {
            res.status(400).send(`Invalid value for parameter 'utxos': ${req.body.utxos.toString()}`);
            return;
        }

        this.ledger_storage
            .getUTXOs(utxos_hash)
            .then((rows: any[]) => {
                const utxo_array: IUnspentTxOutput[] = [];
                for (const row of rows) {
                    const utxo = {
                        utxo: new Hash(row.utxo, Endian.Little).toString(),
                        type: row.type,
                        unlock_height: JSBI.BigInt(row.unlock_height).toString(),
                        amount: JSBI.BigInt(row.amount).toString(),
                        height: JSBI.BigInt(row.block_height).toString(),
                        time: row.block_time,
                        lock_type: row.lock_type,
                        lock_bytes: row.lock_bytes.toString("base64"),
                    };
                    utxo_array.push(utxo);
                }
                res.status(200).send(JSON.stringify(utxo_array));
            })
            .catch((err) => {

                mailService.mailer(Operation.db, err);
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * @deprecated Use getWalletTransactionHistory
     *
     * GET /wallet/transactions/history/:address
     *
     * Called when a request is received through the `/wallet/transactions/history/:address` handler
     * ```
     * The parameter `address` are the address to query.
     * The parameter `pageSize` is the maximum size that can be obtained
     *      from one query, default is 10
     * The parameter `page` is the number on the page, this value begins with 1,
     *      default is 1
     * The parameter `type` is the type of transaction to query.
     *      This can include multiple types.
     *      Transaction types include "inbound", "outbound", "freeze", "payload".
     *      The "inbound" is an increased transaction of funds at the address.
     *      The "outbound" is a transaction with reduced funds at the address.
     *      Users can select only "inbound", "outbound".
     *      The "freeze", "payload" are always included.
     *      default is "inbound,outbound,freeze,payload"
     * The parameter `beginDate` is the start date of the range of dates to look up.
     * The parameter `endDate` is the end date of the range of dates to look up.
     * The parameter `peer` is used when users want to look up only specific
     *      address of their counterparts.
     *      Peer is the withdrawal address in the inbound transaction and
     *      a deposit address in the outbound transaction
     * Returns a set of transactions history of the addresses.
     * ```
     */
    private async getWalletTransactionsHistory(req: express.Request, res: express.Response) {
        const address: string = String(req.params.address);

        let filter_begin: number | undefined;
        let filter_end: number | undefined;
        let filter_type: DisplayTxType[];

        // Validating Parameter - beginDate, endDate
        if (req.query.beginDate !== undefined && req.query.endDate !== undefined) {
            if (!Utils.isPositiveInteger(req.query.beginDate.toString())) {
                res.status(400).send(`Invalid value for parameter 'beginDate': ${req.query.beginDate.toString()}`);
                return;
            }

            if (!Utils.isPositiveInteger(req.query.endDate.toString())) {
                res.status(400).send(`Invalid value for parameter 'endDate': ${req.query.endDate.toString()}`);
                return;
            }

            filter_begin = Number(req.query.beginDate.toString());
            filter_end = Number(req.query.endDate.toString());

            if (filter_begin > filter_end) {
                res.status(400).send(
                    `Parameter beginDate must be less than a parameter endDate. 'beginDate': (${filter_begin}), 'endDate': (${filter_end})`
                );
                return;
            }
        } else if (req.query.beginDate !== undefined && req.query.endDate === undefined) {
            res.status(400).send(`Parameter endDate must also be set.`);
            return;
        } else if (req.query.beginDate === undefined && req.query.endDate !== undefined) {
            res.status(400).send(`Parameter beginDate must also be set.`);
            return;
        } else {
            filter_begin = undefined;
            filter_end = undefined;
        }
        filter_type =
            req.query.type !== undefined
                ? req.query.type
                    .toString()
                    .split(",")
                    .map((m) => ConvertTypes.toDisplayTxType(m))
                : [0, 1, 2, 3];

        if (filter_type.find((m) => m < 0) !== undefined) {
            res.status(400).send(`Invalid transaction type: ${req.query.type}`);
            return;
        }

        const filter_peer = req.query.peer !== undefined ? req.query.peer.toString() : undefined;
        const pagination: IPagination = await this.paginate(req, res);
        this.ledger_storage
            .getWalletTransactionsHistory(
                address,
                pagination.pageSize,
                pagination.page,
                filter_type,
                filter_begin,
                filter_end,
                filter_peer
            )
            .then((rows: any[]) => {
                const out_put: ITxHistoryElement[] = [];
                for (const row of rows) {
                    out_put.push({
                        display_tx_type: lodash.capitalize(ConvertTypes.DisplayTxTypeToString(row.display_tx_type)),
                        address: row.address,
                        peer: row.peer,
                        peer_count: row.peer_count,
                        height: JSBI.BigInt(row.height).toString(),
                        time: row.block_time,
                        tx_hash: new Hash(row.tx_hash, Endian.Little).toString(),
                        tx_type: lodash.capitalize(ConvertTypes.TxTypeToString(row.type)),
                        amount: JSBI.BigInt(row.amount).toString(),
                        unlock_height: JSBI.BigInt(row.unlock_height).toString(),
                        unlock_time: row.unlock_time,
                        tx_fee: row.tx_fee,
                        tx_size: row.tx_size,
                        full_count: row.full_count,
                    });
                }
                res.status(200).send(JSON.stringify(out_put));
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /wallet/transaction/history/:address
     *
     * Called when a request is received through the `/wallet/transaction/history/:address` handler
     * ```
     * The parameter `address` are the address to query.
     * The parameter `pageSize` is the maximum size that can be obtained
     *      from one query, default is 10
     * The parameter `page` is the number on the page, this value begins with 1,
     *      default is 1
     * The parameter `type` is the type of transaction to query.
     *      This can include multiple types.
     *      Transaction types include "inbound", "outbound", "freeze", "payload".
     *      The "inbound" is an increased transaction of funds at the address.
     *      The "outbound" is a transaction with reduced funds at the address.
     *      Users can select only "inbound", "outbound".
     *      The "freeze", "payload" are always included.
     *      default is "inbound,outbound,freeze,payload"
     * The parameter `beginDate` is the start date of the range of dates to look up.
     * The parameter `endDate` is the end date of the range of dates to look up.
     * The parameter `peer` is used when users want to look up only specific
     *      address of their counterparts.
     *      Peer is the withdrawal address in the inbound transaction and
     *      a deposit address in the outbound transaction
     * Returns a set of transactions history of the addresses.
     * ```
     */
    private async getWalletTransactionHistory(req: express.Request, res: express.Response) {
        const address: string = String(req.params.address);

        let filter_begin: number | undefined;
        let filter_end: number | undefined;
        let filter_type: DisplayTxType[];

        // Validating Parameter - beginDate, endDate
        if (req.query.beginDate !== undefined && req.query.endDate !== undefined) {
            if (!Utils.isPositiveInteger(req.query.beginDate.toString())) {
                res.status(400).send(`Invalid value for parameter 'beginDate': ${req.query.beginDate.toString()}`);
                return;
            }

            if (!Utils.isPositiveInteger(req.query.endDate.toString())) {
                res.status(400).send(`Invalid value for parameter 'endDate': ${req.query.endDate.toString()}`);
                return;
            }

            filter_begin = Number(req.query.beginDate.toString());
            filter_end = Number(req.query.endDate.toString());

            if (filter_begin > filter_end) {
                res.status(400).send(
                    `Parameter beginDate must be less than a parameter endDate. 'beginDate': (${filter_begin}), 'endDate': (${filter_end})`
                );
                return;
            }
        } else if (req.query.beginDate !== undefined && req.query.endDate === undefined) {
            res.status(400).send(`Parameter endDate must also be set.`);
            return;
        } else if (req.query.beginDate === undefined && req.query.endDate !== undefined) {
            res.status(400).send(`Parameter beginDate must also be set.`);
            return;
        } else {
            filter_begin = undefined;
            filter_end = undefined;
        }
        filter_type =
            req.query.type !== undefined
                ? req.query.type
                    .toString()
                    .split(",")
                    .map((m) => ConvertTypes.toDisplayTxType(m))
                : [0, 1, 2, 3];

        if (filter_type.find((m) => m < 0) !== undefined) {
            res.status(400).send(`Invalid transaction type: ${req.query.type}`);
            return;
        }

        const filter_peer = req.query.peer !== undefined ? req.query.peer.toString() : undefined;
        const pagination: IPagination = await this.paginate(req, res);
        this.ledger_storage
            .getWalletTransactionsHistory(
                address,
                pagination.pageSize,
                pagination.page,
                filter_type,
                filter_begin,
                filter_end,
                filter_peer
            )
            .then(async (rows: any[]) => {
                let full_count = 0;
                if (rows.length === 0) {
                    if (pagination.page > 1) {
                        const rows_second = await this.ledger_storage.getWalletTransactionsHistory(
                            address,
                            pagination.pageSize,
                            1,
                            filter_type,
                            filter_begin,
                            filter_end,
                            filter_peer
                        );
                        full_count = rows_second.length > 0 ? rows_second[0].full_count : 0;
                    }
                } else {
                    full_count = rows[0].full_count;
                }

                const total_page = full_count === 0 ? 0 : Math.floor((full_count - 1) / pagination.pageSize) + 1;
                const header: ITxHistoryHeader = {
                    address,
                    page_size: pagination.pageSize,
                    page: pagination.page,
                    total_page,
                    type: filter_type.map((m: DisplayTxType) => ConvertTypes.DisplayTxTypeToString(m)),
                    begin_date: filter_begin,
                    end_date: filter_end,
                    peer: filter_peer,
                };

                const items: ITxHistoryItem[] = [];
                for (const row of rows) {
                    items.push({
                        display_tx_type: ConvertTypes.DisplayTxTypeToString(row.display_tx_type),
                        address: row.address,
                        peer: row.peer,
                        peer_count: row.peer_count,
                        height: JSBI.BigInt(row.height).toString(),
                        time: row.block_time,
                        tx_hash: new Hash(row.tx_hash, Endian.Little).toString(),
                        tx_type: ConvertTypes.TxTypeToString(row.type),
                        amount: JSBI.BigInt(row.amount).toString(),
                        unlock_height: JSBI.BigInt(row.unlock_height).toString(),
                        unlock_time: row.unlock_time,
                        tx_fee: row.tx_fee,
                        tx_size: row.tx_size,
                    });
                }
                const history: ITxHistory = {
                    header,
                    items,
                };
                res.status(200).send(JSON.stringify(history));
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /wallet/transaction/overview/:hash
     *
     * Called when a request is received through the `/transaction_overview/:addresses` handler
     * The parameter `hash` is the hash of the transaction
     *
     * Returns a transaction overview.
     * @deprecated Use getWalletTransactionDetail
     */
    private getWalletTransactionOverview(req: express.Request, res: express.Response) {
        const txHash: string = String(req.params.hash);

        let tx_hash: Hash;
        try {
            tx_hash = new Hash(txHash);
        } catch (error) {
            res.status(400).send(`Invalid value for parameter 'hash': ${txHash}`);
            return;
        }

        this.ledger_storage
            .getWalletTransactionOverview(tx_hash)
            .then((data: any) => {
                if (
                    data === undefined ||
                    data.tx === undefined ||
                    data.senders === undefined ||
                    data.receivers === undefined
                ) {
                    res.status(500).send("Failed to data lookup");
                    return;
                }

                if (data.tx.length === 0) {
                    res.status(204).send(`The data does not exist. 'hash': (${tx_hash})`);
                    return;
                }

                const overview: ITxOverview = {
                    status: "Confirmed",
                    height: JSBI.BigInt(data.tx[0].height).toString(),
                    time: data.tx[0].block_time,
                    tx_hash: new Hash(data.tx[0].tx_hash, Endian.Little).toString(),
                    tx_type: lodash.capitalize(ConvertTypes.TxTypeToString(data.tx[0].type)),
                    tx_size: data.tx[0].tx_size,
                    unlock_height: JSBI.BigInt(data.tx[0].unlock_height).toString(),
                    lock_height: JSBI.BigInt(data.tx[0].lock_height).toString(),
                    unlock_time: data.tx[0].unlock_time,
                    payload: data.tx[0].payload !== null ? Buffer.byteLength(data.tx[0].payload).toString() : "",
                    senders: [],
                    receivers: [],
                    fee: JSBI.add(JSBI.BigInt(data.tx[0].tx_fee), JSBI.BigInt(data.tx[0].payload_fee)).toString(),
                    dataFee: JSBI.BigInt(data.tx[0].payload_fee).toString()
                };

                for (const elem of data.senders)
                    overview.senders.push({
                        address: elem.address,
                        amount: elem.amount,
                        utxo: new Hash(elem.utxo, Endian.Little).toString(),
                        signature: new Signature(elem.signature, Endian.Little).toString(),
                        index: elem.in_index,
                        unlock_age: ConvertTypes.unlockAgeToString(elem.unlock_age),
                        bytes: elem.bytes.toString("base64"),
                    });

                for (const elem of data.receivers)
                    overview.receivers.push({
                        type: elem.type,
                        address: elem.address,
                        lock_type: ConvertTypes.lockTypeToString(elem.lock_type),
                        amount: elem.amount,
                        utxo: new Hash(elem.utxo, Endian.Little).toString(),
                        index: elem.output_index,
                        bytes: elem.bytes.toString("base64"),
                    });

                res.status(200).send(JSON.stringify(overview));
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /wallet/transaction/pending/overview/:hash
     *
     * Called when a request is received through the `/transaction_overview/pending/:addresses` handler
     * The parameter `hash` is the hash of the transaction
     *
     * Returns a transaction overview.
     * @deprecated Use getWalletTransactionDetail
     */
    private getWalletPendingTransactionOverview(req: express.Request, res: express.Response) {
        const txHash: string = String(req.params.hash);

        let tx_hash: Hash;
        try {
            tx_hash = new Hash(txHash);
        } catch (error) {
            res.status(400).send(`Invalid value for parameter 'hash': ${txHash}`);
            return;
        }

        this.ledger_storage
            .getWalletPendingTransactionOverview(tx_hash)
            .then((data: any) => {
                if (
                    data === undefined ||
                    data.tx === undefined ||
                    data.senders === undefined ||
                    data.receivers === undefined
                ) {
                    res.status(500).send("Failed to data lookup");
                    return;
                }

                if (data.tx.length === 0) {
                    res.status(204).send(`The data does not exist. 'hash': (${tx_hash})`);
                    return;
                }

                const overview: ITxOverview = {
                    status: data.tx[0].status,
                    height: "",
                    time: data.tx[0].time,
                    tx_hash: new Hash(data.tx[0].tx_hash, Endian.Little).toString(),
                    tx_type: lodash.capitalize(ConvertTypes.TxTypeToString(data.tx[0].type)),
                    tx_size: data.tx[0].tx_size,
                    unlock_height: JSBI.BigInt(0).toString(),
                    lock_height: JSBI.BigInt(data.tx[0].lock_height).toString(),
                    unlock_time: 0,
                    payload: data.tx[0].payload !== null ? Buffer.byteLength(data.tx[0].payload).toString() : "",
                    senders: [],
                    receivers: [],
                    fee: JSBI.add(JSBI.BigInt(data.tx[0].tx_fee), JSBI.BigInt(data.tx[0].payload_fee)).toString(),
                    dataFee: JSBI.BigInt(data.tx[0].payload_fee).toString()
                };

                for (const elem of data.senders) {
                    overview.senders.push({
                        address: elem.address,
                        amount: Number(elem.amount),
                        utxo: new Hash(elem.utxo, Endian.Little).toString(),
                        signature: '',
                        index: elem.input_index,
                        unlock_age: ConvertTypes.unlockAgeToString(elem.unlock_age),
                        bytes: elem.unlock_bytes.toString("base64"),
                    });
                }

                for (const elem of data.receivers)
                    overview.receivers.push({
                        type: elem.type,
                        address: elem.address,
                        lock_type: ConvertTypes.lockTypeToString(elem.lock_type),
                        amount: elem.amount,
                        utxo: '',
                        index: elem.output_index,
                        bytes: elem.lock_bytes.toString("base64"),
                    });

                res.status(200).send(JSON.stringify(overview));
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /wallet/transaction/detail/:hash
     *
     * Called when a request is received through the `/wallet/transaction/detail/:hash` handler
     * The parameter `hash` is the hash of the transaction
     *
     * Returns a transaction overview.
     */
    private getWalletTransactionDetail(req: express.Request, res: express.Response) {
        const txHash: string = String(req.params.hash);

        let tx_hash: Hash;
        try {
            tx_hash = new Hash(txHash);
        } catch (error) {
            res.status(400).send(`Invalid value for parameter 'hash': ${txHash}`);
            return;
        }

        this.ledger_storage
            .getWalletTransactionDetail(tx_hash)
            .then((data: any) => {
                if (
                    data === undefined ||
                    data.tx === undefined ||
                    data.senders === undefined ||
                    data.receivers === undefined
                ) {
                    res.status(500).send("Failed to data lookup");
                    return;
                }

                if (data.tx.length === 0) {
                    res.status(204).send(`The data does not exist. 'hash': (${tx_hash})`);
                    return;
                }

                const detail: ITxDetail = {
                    status: "Confirmed",
                    height: JSBI.BigInt(data.tx[0].height).toString(),
                    time: data.tx[0].block_time,
                    tx_hash: new Hash(data.tx[0].tx_hash, Endian.Little).toString(),
                    tx_type: ConvertTypes.TxTypeToString(data.tx[0].type),
                    tx_size: data.tx[0].tx_size,
                    unlock_height: JSBI.BigInt(data.tx[0].unlock_height).toString(),
                    lock_height: JSBI.BigInt(data.tx[0].lock_height).toString(),
                    unlock_time: data.tx[0].unlock_time,
                    payload: data.tx[0].payload !== null ? data.tx[0].payload.toString("base64") : "",
                    senders: [],
                    receivers: [],
                    fee: JSBI.add(JSBI.BigInt(data.tx[0].tx_fee), JSBI.BigInt(data.tx[0].payload_fee)).toString(),
                    tx_fee: JSBI.BigInt(data.tx[0].tx_fee).toString(),
                    payload_fee: JSBI.BigInt(data.tx[0].payload_fee).toString(),
                };

                for (const elem of data.senders)
                    detail.senders.push({
                        address: elem.address,
                        amount: elem.amount,
                        utxo: new Hash(elem.utxo, Endian.Little).toString(),
                        signature: new Signature(elem.signature, Endian.Little).toString(),
                        index: elem.in_index,
                        unlock_age: elem.unlock_age,
                        bytes: elem.bytes.toString("base64"),
                    });

                for (const elem of data.receivers)
                    detail.receivers.push({
                        type: elem.type,
                        address: elem.address,
                        lock_type: elem.lock_type,
                        amount: elem.amount,
                        utxo: new Hash(elem.utxo, Endian.Little).toString(),
                        index: elem.output_index,
                        bytes: elem.bytes.toString("base64"),
                    });

                res.status(200).send(JSON.stringify(detail));
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /block-summary
     *
     * Called when a request is received through the `/block-summary` handler
     * The parameter `height` is the height and `hash` is the hash of block
     *
     * Returns a block overview.
     */
    private getBlockSummary(req: express.Request, res: express.Response) {
        let field: string;
        let value: string | Buffer;

        // Validating Parameter - height
        if (req.query.height !== undefined && Utils.isPositiveInteger(req.query.height.toString())) {
            field = "height";
            value = String(req.query.height);
        }
        // Validating Parameter - hash
        else if (req.query.hash !== undefined) {
            field = "hash";
            try {
                const req_hash: string = String(req.query.hash);
                value = new Hash(req_hash).toBinary(Endian.Little);
            } catch (error) {
                res.status(400).send(`Invalid value for parameter 'hash': ${req.query.hash}`);
                return;
            }
        } else {
            res.status(400).send(
                `Invalid value for parameter 'height': ${req.query.height} and 'hash': ${req.query.hash}`
            );
            return;
        }

        this.ledger_storage
            .getBlockSummary(field, value)
            .then((data: any) => {
                if (data === undefined) {
                    res.status(500).send("Failed to data lookup");
                    return;
                } else if (data.length === 0) {
                    res.status(204).send(`The data does not exist. 'height': (${value})`);
                    return;
                } else {
                    const overview: IBlockOverview = {
                        height: JSBI.BigInt(data[0].height).toString(),
                        total_transactions: data[0].tx_count,
                        hash: new Hash(data[0].hash, Endian.Little).toString(),
                        prev_hash: new Hash(data[0].prev_block, Endian.Little).toString(),
                        merkle_root: new Hash(data[0].merkle_root, Endian.Little).toString(),
                        signature: new Signature(data[0].signature, Endian.Little).toString(),
                        random_seed: "",
                        time: data[0].time_stamp,
                        version: "",
                        total_sent: data[0].total_sent,
                        total_received: data[0].total_received,
                        total_reward: data[0].total_reward,
                        total_fee: data[0].total_fee,
                        total_size: data[0].total_size,
                        tx_volume: JSBI.add(
                            JSBI.add(JSBI.BigInt(data[0].total_received), JSBI.BigInt(data[0].total_fee)),
                            JSBI.BigInt(data[0].total_reward)
                        ).toString(),
                    };
                    res.status(200).send(JSON.stringify(overview));
                }
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /block-enrollments
     *
     * Called when a request is received through the `/block-enrollments` handler
     * The parameter `height` is the height and `hash` is the hash of block
     *
     *@returns enrolled validators of block.
     */
    private async getBlockEnrollments(req: express.Request, res: express.Response) {
        let field: string;
        let value: string | Buffer;

        // Validating Parameter - height
        if (req.query.height !== undefined && Utils.isPositiveInteger(req.query.height.toString())) {
            field = "height";
            value = String(req.query.height);
        }
        // Validating Parameter - hash
        else if (req.query.hash !== undefined) {
            field = "hash";
            try {
                const req_hash: string = String(req.query.hash);
                value = new Hash(req_hash).toBinary(Endian.Little);
            } catch (error) {
                res.status(400).send(`Invalid value for parameter 'hash': ${req.query.hash}`);
                return;
            }
        } else {
            res.status(400).send(
                `Invalid value for parameter 'height': ${req.query.height} and 'hash': ${req.query.hash}`
            );
            return;
        }

        const pagination: IPagination = await this.paginate(req, res);
        this.ledger_storage
            .getBlockEnrollments(field, value, pagination.pageSize, pagination.page)
            .then((data: any) => {
                if (data === undefined) {
                    res.status(500).send("Failed to data lookup");
                    return;
                } else if (data.total_records === 0) {
                    return res.status(204).send(`The data does not exist. 'height': (${value})`);
                } else {
                    const enrollmentElementList: IBlockEnrollment[] = [];
                    for (const row of data.enrollments) {
                        enrollmentElementList.push({
                            height: JSBI.BigInt(row.block_height).toString(),
                            utxo: new Hash(row.utxo_key, Endian.Little).toString(),
                            enroll_sig: new Hash(row.enroll_sig, Endian.Little).toString(),
                            commitment: new Hash(row.commitment, Endian.Little).toString(),
                            full_count: row.full_count,
                            cycle_length: this.validator_cycle
                        });
                    }
                    return res.status(200).send(JSON.stringify(enrollmentElementList));
                }
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                return res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /block-transactions
     *
     * Called when a request is received through the `/block-transactions` handler
     * The parameter `height` is the height and `hash` is the hash of block
     *
     * @returns Returns transactions of block.
     */
    private async getBlockTransactions(req: express.Request, res: express.Response) {
        let field: string;
        let value: string | Buffer;

        // Validating Parameter - height
        if (req.query.height !== undefined && Utils.isPositiveInteger(req.query.height.toString())) {
            field = "height";
            value = String(req.query.height);
        }
        // Validating Parameter - hash
        else if (req.query.hash !== undefined) {
            field = "hash";
            try {
                const req_hash: string = String(req.query.hash);
                value = new Hash(req_hash).toBinary(Endian.Little);
            } catch (error) {
                res.status(400).send(`Invalid value for parameter 'hash': ${req.query.hash}`);
                return;
            }
        } else {
            res.status(400).send(
                `Invalid value for parameter 'height': ${req.query.height} and 'hash': ${req.query.hash}`
            );
            return;
        }

        const pagination: IPagination = await this.paginate(req, res);
        this.ledger_storage
            .getBlockTransactions(field, value, pagination.pageSize, pagination.page)
            .then((data: any) => {
                if (data === undefined) {
                    res.status(500).send("Failed to data lookup");
                    return;
                } else if (data.tx.length === 0) {
                    return res.status(204).send(`The data does not exist. 'height': (${value})`);
                } else {
                    const txs: IBlockTransactions[] = [];
                    for (const row of data.tx) {
                        txs.push({
                            height: JSBI.BigInt(row.block_height).toString(),
                            tx_hash: new Hash(row.tx_hash, Endian.Little).toString(),
                            amount: row.amount,
                            type: lodash.capitalize(ConvertTypes.TxTypeToString(row.receiver[0].type)),
                            fee: row.tx_fee,
                            size: row.tx_size,
                            time: row.time_stamp,
                            sender_address: row.senders ? row.senders : null,
                            receiver: row.receiver,
                            full_count: row.full_count,
                        });
                    }
                    return res.status(200).send(JSON.stringify(txs));
                }
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /boa-stats
     *
     * Called when a request is received through the `/boa-stats` handler
     *
     * @returns Returns statistics of BOA coin.
     */
    private getBOAStats(req: express.Request, res: express.Response) {
        let currency: string;
        if (req.query.currency === undefined) {
            currency = CurrencyType.USD;
        } else {
            currency = String(req.query.currency);
        }
        this.ledger_storage
            .getBOAStats()
            .then(async (data: any[]) => {
                if (!data[0]) {
                    return res.status(500).send("Failed to data lookup");
                } else {
                    let exchangeRate = await this.ledger_storage.getExchangeRate(currency);
                    let exchange = new Exchange(exchangeRate);
                    const boaStats: IBOAStats = {
                        height: data[0].height,
                        transactions: data[0].transactions,
                        validators: data[0].validators,
                        frozen_coin: data[0].total_frozen,
                        total_reward: data[0].total_reward,
                        time_stamp: data[0].time_stamp,
                        circulating_supply: data[0].circulating_supply,
                        active_validators: data[0].active_validator,
                        price: exchange.convertAmountToCurrency(new Amount(Number(data[0].circulating_supply)))
                    };
                    return res.status(200).send(JSON.stringify(boaStats));
                }
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                return res.status(500).send("Failed to data lookup");
            });
    }

    private verifyPayment(req: express.Request, res: express.Response) {
        const req_hash: string = String(req.params.hash);

        let tx_hash: Hash;

        try {
            tx_hash = new Hash(req_hash);
        } catch (error) {
            res.status(400).send(`Invalid value for parameter 'hash': ${hash}`);
            return;
        }

        this.ledger_storage
            .getBlockHeaderByTxHash(tx_hash)
            .then((rows: any) => {
                if (rows.length === 0) {
                    const status: ISPVStatus = {
                        result: false,
                        message: "Transaction does not exist in block",
                    };
                    res.status(200).send(JSON.stringify(status));
                    return;
                }
                this.agora
                    .getMerklePath(rows[0].height, tx_hash)
                    .then((path: Hash[]) => {
                        const root = new Hash(rows[0].merkle_root, Endian.Little);

                        if (
                            Buffer.compare(
                                AgoraClient.checkMerklePath(path, tx_hash, rows[0].tx_index).data,
                                root.data
                            ) === 0
                        ) {
                            const status: ISPVStatus = {
                                result: true,
                                message: "Success",
                            };
                            res.status(200).send(JSON.stringify(status));
                        } else {
                            const status: ISPVStatus = {
                                result: false,
                                message: "Verification failed",
                            };
                            res.status(200).send(JSON.stringify(status));
                        }
                    })
                    .catch((error) => {
                        const status: ISPVStatus = {
                            result: false,
                            message: error.message,
                        };
                        res.status(200).send(JSON.stringify(status));
                    });
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * POST /block_externalized
     *
     * When a request is received through the `/push` handler
     * we we call the storage handler asynchronously and  immediately
     * respond to Agora.
     */
    private postBlock(req: express.Request, res: express.Response) {
        if (req.body.block === undefined) {
            res.status(400).send({
                statusMessage: "Missing 'block' object in body",
            });
            return;
        }

        logger.info(`POST /block_externalized}`, {
            operation: Operation.db,
            height: HeightManager.height.toString(),
            status: Status.Success,
            responseTime: Number(moment().utc().unix() * 1000),
        });

        // To do
        // For a more stable operating environment,
        // it would be necessary to consider organizing the pool
        // using the database instead of the array.
        this.pending = this.pending.then(() => {
            return this.task({ type: "block", data: req.body.block });
        });

        res.status(200).send();
    }

    /**
     * POST /block_header_updated
     *
     * When a request is received through the `/block_header_updated` handler
     * we we call the storage handler asynchronously and  immediately
     * respond to Agora.
     */
    private postBlockHeaderUpdate(req: express.Request, res: express.Response) {
        if (req.body.header === undefined) {
            res.status(400).send({
                statusMessage: "Missing 'header' object in body",
            });
            return;
        }

        logger.info(`POST /block_header_updated}`, {
            operation: Operation.db,
            height: HeightManager.height.toString(),
            status: Status.Success,
            responseTime: Number(moment().utc().unix() * 1000),
        });

        this.pending = this.pending.then(() => {
            return this.task({ type: "block_header", data: req.body.header });
        });

        res.status(200).send();
    }

    /**
     * POST /preimage_received
     *
     * When a request is received through the `/preimage_received` handler
     * JSON preImage data is parsed and stored on each storage.
     */
    private putPreImage(req: express.Request, res: express.Response) {
        if (req.body.preimage === undefined) {
            res.status(400).send({
                statusMessage: "Missing 'preimage' object in body",
            });
            return;
        }

        // To do
        // For a more stable operating environment,
        // it would be necessary to consider organizing the pool
        // using the database instead of the array.
        this.pending = this.pending.then(() => {
            return this.task({ type: "pre_image", data: req.body.preimage });
        });

        res.status(200).send();
    }

    /**
     * Put Coin market data to database
     *
     * This method Store the Coin market data to database.
     */
    public putCoinMarketStats(data: IMarketCap): Promise<any> {
        return new Promise<any>(async (resolve, reject) => {
            this.ledger_storage
                .storeCoinMarket(data)
                .then((result: any) => {
                    if (result.affectedRows) {
                        logger.info(`CoinMarket: Data Update Completed ${data.currency}`, {
                            operation: Operation.db,
                            height: HeightManager.height.toString(),
                            status: Status.Success,
                            responseTime: Number(moment().utc().unix() * 1000),
                        });
                        resolve(result);
                    }
                })
                .catch((err) => {
                    mailService.mailer(Operation.db, err);
                    logger.error("Failed to Store coin market cap data." + err, {
                        operation: Operation.db,
                        height: HeightManager.height.toString(),
                        status: Status.Error,
                        responseTime: Number(moment().utc().unix() * 1000),
                    });
                    reject(err);
                });
        });
    }

    /**
     * POST /transaction_received
     *
     * When a request is received through the `/transaction_received` handler
     * JSON transaction data is parsed and stored on each storage.
     */
    private putTransaction(req: express.Request, res: express.Response) {
        if (req.body.tx === undefined) {
            res.status(400).send({
                statusMessage: "Missing 'tx' object in body",
            });
            return;
        }

        this.pending = this.pending.then(() => {
            return this.task({ type: "transaction", data: req.body.tx });
        });

        res.status(200).send();
    }

    /**
     * GET /wallet/transactions/pending/:address
     *
     * Called when a request is received through the `/transactions/pending/:address` handler
     *
     * Returns List the total by output address of the pending transaction.
     */
    private getWalletTransactionsPending(req: express.Request, res: express.Response) {
        const address: string = String(req.params.address);

        this.ledger_storage
            .getWalletTransactionsPending(address)
            .then((rows: any[]) => {
                const pending_array: IPendingTxs[] = [];
                for (const row of rows) {
                    const tx = {
                        tx_hash: new Hash(row.tx_hash, Endian.Little).toString(),
                        submission_time: row.time,
                        address: row.address,
                        amount: JSBI.BigInt(row.amount).toString(),
                        fee: JSBI.add(JSBI.BigInt(row.tx_fee), JSBI.BigInt(row.payload_fee)).toString(),
                        block_delay: row.current_height - row.received_height,
                        peer_count: row.peer_count,
                    };
                    pending_array.push(tx);
                }
                res.status(200).send(JSON.stringify(pending_array));
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /wallet/balance/:address
     *
     * Called when a request is received through the `/wallet/balance/:address` handler
     *
     * Returns the balance of the address
     */
    private getWalletBalance(req: express.Request, res: express.Response) {
        const address: string = String(req.params.address);

        this.ledger_storage
            .getWalletBalance(address)
            .then((data: any[]) => {
                if (data.length === 0) {
                    res.status(500).send("Failed to data lookup");
                    return;
                }

                const balance = {
                    address: data[0].address,
                    balance: JSBI.BigInt(data[0].balance).toString(),
                    spendable: JSBI.BigInt(data[0].spendable).toString(),
                    frozen: JSBI.BigInt(data[0].frozen).toString(),
                    locked: JSBI.BigInt(data[0].locked).toString(),
                };
                res.status(200).send(JSON.stringify(balance));
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /wallet/utxo/:address
     *
     * Called when a request is received through the `/utxo/:address` handler
     *
     * Returns a set of UTXOs of the address.
     */
    private getWalletUTXO(req: express.Request, res: express.Response) {
        const address: string = String(req.params.address);

        let amount: JSBI;
        if (req.query.amount === undefined) {
            res.status(400).send(`Parameters 'amount' is not entered.`);
            return;
        } else if (!Utils.isPositiveInteger(req.query.amount.toString())) {
            res.status(400).send(`Invalid value for parameter 'amount': ${req.query.amount.toString()}`);
            return;
        }
        amount = JSBI.BigInt(req.query.amount.toString());

        // Balance Type (0: Spendable, 1: Frozen, 2: Locked)
        let balance_type: number;
        if (req.query.type !== undefined) {
            balance_type = Number(req.query.type.toString());
        } else {
            balance_type = 0;
        }

        // Last UTXO in previous request
        let last_utxo: Hash | undefined;
        if (req.query.last !== undefined) {
            try {
                last_utxo = new Hash(String(req.query.last));
            } catch (error) {
                res.status(400).send(`Invalid value for parameter 'last': ${req.query.last.toString()}`);
                return;
            }
        } else {
            last_utxo = undefined;
        }

        this.ledger_storage
            .getWalletUTXO(address, amount, balance_type, last_utxo)
            .then((rows: any[]) => {
                const utxo_array: IUnspentTxOutput[] = [];
                for (const row of rows) {
                    const utxo = {
                        utxo: new Hash(row.utxo, Endian.Little).toString(),
                        type: row.type,
                        unlock_height: JSBI.BigInt(row.unlock_height).toString(),
                        amount: JSBI.BigInt(row.amount).toString(),
                        height: JSBI.BigInt(row.block_height).toString(),
                        time: row.block_time,
                        lock_type: row.lock_type,
                        lock_bytes: row.lock_bytes.toString("base64"),
                    };
                    utxo_array.push(utxo);
                }
                res.status(200).send(JSON.stringify(utxo_array));
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /wallet/blocks/header
     *
     * Called when a request is received through the `/wallet/blocks/header`
     *
     * Returns information about the header of the block according to the height of the block.
     * If height was not provided the information of the last block header is returned.
     */
    private getWalletBlocksHeader(req: express.Request, res: express.Response) {
        if (req.query.height !== undefined && !Utils.isPositiveInteger(req.query.height.toString())) {
            res.status(400).send(`Invalid value for parameter 'height': ${req.query.height.toString()}`);
            return;
        }

        const height = req.query.height !== undefined ? new Height(req.query.height.toString()) : null;

        if (height != null)
            logger.http(`GET /wallet/blocks/header height=${height.toString()}`, {
                operation: Operation.Http_request,
                height: HeightManager.height.toString(),
                status: Status.Error,
                responseTime: Number(moment().utc().unix() * 1000),
            });

        this.ledger_storage
            .getWalletBlocksHeaderInfo(height)
            .then((rows: any[]) => {
                if (!rows.length) {
                    res.status(204).send(`No blocks`);
                    return;
                }

                const info = {
                    height: rows[0].height.toString(),
                    hash: new Hash(rows[0].hash, Endian.Little).toString(),
                    merkle_root: new Hash(rows[0].merkle_root, Endian.Little).toString(),
                    time_stamp: rows[0].time_stamp,
                };
                res.status(200).send(JSON.stringify(info));
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /block_height
     *
     * Return the highest block height stored in Stoa
     */
    private getBlockHeight(req: express.Request, res: express.Response) {
        this.ledger_storage
            .getBlockHeight()
            .then((row: Height | null) => {
                if (row == null) res.status(400).send(`The block height not found.`);
                else res.status(200).send(JSON.stringify(row));
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /block_height_at/:time
     *
     * Return the block height corresponding to to the block creation time
     */
    private getBlockHeightAt(req: express.Request, res: express.Response) {
        if (req.params.time === undefined) {
            res.status(400).send(`Invalid value for parameter 'time'`);
            return;
        }

        if (!Utils.isPositiveInteger(req.params.time.toString())) {
            res.status(400).send(`Invalid value for parameter 'time': ${req.params.time.toString()}`);
            return;
        }

        const time_stamp = Number(req.params.time.toString());

        this.ledger_storage
            .getEstimatedBlockHeight(time_stamp)
            .then((height: Height | null) => {
                if (height === null) res.status(204).send("No Content");
                else res.status(200).send(JSON.stringify(height));
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * Extract the block height from JSON.
     * @param block
     */
    private static getJsonBlockHeight(block: any): Height {
        if (block.header === undefined || block.header.height === undefined) {
            throw Error("Not found block height in JSON Block");
        }

        return new Height(block.header.height);
    }

    /**
     * Get latest blocks
     * @param req
     * @param res
     * @returns Return Latest blocks of the ledger
     */
    private async getLatestBlocks(req: express.Request, res: express.Response) {
        const pagination: IPagination = await this.paginate(req, res);
        this.ledger_storage.getLatestBlocks(pagination.pageSize, pagination.page).then((data: any) => {
            if (data === undefined) {
                res.status(500).send("Failed to data lookup");
                return;
            } else if (data.length === 0) {
                return res.status(204).send(`The data does not exist.`);
            } else {
                const blocklist: IBlock[] = [];
                for (const row of data) {
                    let validator_array = Array.from(row.validators);
                    let validator_count = 0;
                    validator_array.map(elem => {
                        if (elem == 1) {
                            ++validator_count;
                        }
                    });
                    blocklist.push({
                        height: JSBI.BigInt(row.height).toString(),
                        hash: new Hash(row.hash, Endian.Little).toString(),
                        merkle_root: new Hash(row.merkle_root, Endian.Little).toString(),
                        signature: new Hash(row.signature, Endian.Little).toString(),
                        validators: validator_count,
                        tx_count: row.tx_count.toString(),
                        enrollment_count: row.enrollment_count.toString(),
                        time_stamp: row.time_stamp,
                        full_count: row.full_count,
                    });
                }
                return res.status(200).send(JSON.stringify(blocklist));
            }
        });
    }

    /**
     * Get Latest transactions
     * @param req
     * @param res
     * @returns Returns Latest transactions of the ledger.
     */
    private async getLatestTransactions(req: express.Request, res: express.Response) {
        const pagination: IPagination = await this.paginate(req, res);
        this.ledger_storage.getLatestTransactions(pagination.pageSize, pagination.page).then((data: any) => {
            if (data === undefined) {
                res.status(500).send("Failed to data lookup");
                return;
            } else if (data.length === 0) {
                return res.status(204).send(`The data does not exist.`);
            } else {
                let count = 0;
                if (data[0].status === 'Pending') {
                    count = data[0].full_count;
                    count += data[data.length - 1].full_count;
                } else {
                    count = data[data.length - 1].full_count;
                }
                const transactionList: ITransaction[] = [];
                for (const row of data) {
                    transactionList.push({
                        height: row.block_height !== '' ? JSBI.BigInt(row.block_height).toString() : '',
                        tx_hash: new Hash(row.tx_hash, Endian.Little).toString(),
                        type: lodash.capitalize(ConvertTypes.TxTypeToString(row.type)),
                        amount: JSBI.BigInt(row.amount).toString(),
                        tx_fee: JSBI.BigInt(row.tx_fee).toString(),
                        tx_size: JSBI.BigInt(row.tx_size).toString(),
                        time_stamp: row.time_stamp,
                        status: row.status,
                        full_count: count,
                    });
                }
                return res.status(200).send(JSON.stringify(transactionList));
            }
        });
    }

    /**
     * Get Coin Market Cap for BOA.
     * @param req
     * @param res
     * @returns Returns Coin market cap.
     */
    private async getCoinMarketCap(req: express.Request, res: express.Response) {
        const currency = String(req.query.currency);
        this.ledger_storage
            .getCoinMarketcap(currency)
            .then((rows: any) => {
                if (rows[0]) {
                    return res.status(200).send(rows[0]);
                } else {
                    return res.status(204).send(`The data does not exist.`);
                }
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * Restores blocks from expected_height to height - 1 and saves recently received block.
     * @param block The recently received block data
     * @param height The height of the recently received block data
     * @param expected_height The height of the block to save
     * @returns Returns the Promise. If it is finished successfully the `.then`
     * of the returned Promise is called
     * and if an error occurs the `.catch` is called with an error.
     */
    private recoverBlock(block: any, height: Height, expected_height: Height): Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
            (async () => {
                try {
                    let max_blocks = JSBI.add(
                        JSBI.subtract(height.value, expected_height.value),
                        block == null ? JSBI.BigInt(1) : JSBI.BigInt(0)
                    );

                    if (JSBI.greaterThan(max_blocks, JSBI.BigInt(this._max_count_on_recovery)))
                        max_blocks = JSBI.BigInt(this._max_count_on_recovery);

                    if (JSBI.greaterThan(max_blocks, JSBI.BigInt(0))) {
                        const blocks = await this.agora.getBlocksFrom(expected_height, Number(max_blocks));

                        // Save previous block
                        for (const data of blocks) {
                            if (JSBI.equal(data.header.height.value, expected_height.value)) {
                                await this.ledger_storage.putBlocks(data);
                                await this.emitBlock(data);
                                await this.emitBoaStats();
                                await this.emitWalletEventOnCreateBlock(data);
                                expected_height.value = JSBI.add(expected_height.value, JSBI.BigInt(1));
                                HeightManager.height = new Height(data.header.height.toString());
                                logger.info(`Recovered a block with block height of ${data.header.height.toString()}`, {
                                    operation: Operation.block_recovery,
                                    height: HeightManager.height.toString(),
                                    status: Status.Success,
                                    responseTime: Number(moment().utc().unix() * 1000),
                                });
                            } else {
                                resolve(false);
                                return;
                            }
                        }
                    }

                    // Save a block just received
                    if (JSBI.lessThanOrEqual(height.value, expected_height.value)) {
                        if (block != null) {
                            await this.ledger_storage.putBlocks(Block.reviver("", block));
                            HeightManager.height = new Height(block.header.height.toString());
                            logger.info(`Saved a block with block height of ${height.toString()}`, {
                                operation: Operation.block_sync,
                                height: HeightManager.height.toString(),
                                status: Status.Success,
                                responseTime: Number(moment().utc().unix() * 1000),
                            });
                        }
                        resolve(true);
                    } else {
                        if (block !== null) {
                            HeightManager.height = new Height(block.header.height.toString());
                            logger.info(`Save of block ${height.toString()} postponed to`, {
                                operation: Operation.block_sync,
                                height: HeightManager.height.toString(),
                                status: Status.Success,
                                responseTime: Number(moment().utc().unix() * 1000),
                            });
                        }
                        resolve(false);
                    }
                } catch (err) {
                    reject(err);
                }
            })();
        });
    }

    private async emitWalletEventOnCreateBlock(block: Block) {
        for (const tx of block.txs) {
            const tx_hash = hashFull(tx);
            const addresses: string[] = [];
            if (tx.inputs.length > 0) {
                const utxos = tx.inputs.map((m: TxInput) => m.utxo);
                const res = await this.ledger_storage.getAddressesOfUTXOs(utxos);
                addresses.push(...res.map((m) => m.address));
            }
            tx.outputs
                .filter((m) => m.lock.type === LockType.Key)
                .forEach((m) => {
                    const address = new PublicKey(m.lock.bytes).toString();
                    if (addresses.findIndex((n) => n === address) < 0) addresses.push(address);
                });
            addresses.forEach((m) => this.wallet_watcher.onTransactionAccountCreated(m, tx_hash, "confirm"));
        }
    }

    /**
     * Process pending data and put it into the storage.
     *
     * This function will take care of querying Agora if some blocks are missing.
     * It is separate from the actual handler as we don't want to suffer timeout
     * on the connection, hence we reply with a 200 before the info is stored.
     * This also means that we need to store data serially, in the order it arrived,
     * hence the `pending: Promise<void>` member acts as a queue.
     *
     * @returns A new `Promise<void>` for the caller to chain with `pending`.
     */
    private task(stored_data: IPooledData): Promise<void> {
        return new Promise<void>(async (resolve, reject) => {
            if (stored_data === undefined) {
                resolve();
                return;
            }

            if (stored_data.type === "block") {
                const block_data = stored_data.data;

                try {
                    const height = Stoa.getJsonBlockHeight(block_data);
                    let expected_height = await this.ledger_storage.getExpectedBlockHeight();

                    if (JSBI.equal(height.value, expected_height.value)) {
                        // The normal case
                        // Save a block just received
                        const block = Block.reviver("", block_data);
                        await this.ledger_storage.putBlocks(block);
                        HeightManager.height = new Height(height.toString());
                        logger.info(`Saved a block with block height of ${height.toString()}`, {
                            operation: Operation.db,
                            height: HeightManager.height.toString(),
                            status: Status.Success,
                            responseTime: Number(moment().utc().unix() * 1000),
                        });
                        await this.emitBlock(block);
                        await this.emitBoaStats();
                        await this.emitWalletEventOnCreateBlock(block);
                    } else if (JSBI.greaterThan(height.value, expected_height.value)) {
                        // Recovery is required for blocks that are not received.
                        while (true) {
                            if (await this.recoverBlock(block_data, height, expected_height)) break;
                            expected_height = await this.ledger_storage.getExpectedBlockHeight();
                        }
                    } else {
                        // Do not save because it is already a saved block.
                        logger.info(`Ignored a block with block height of ${height.toString()}`, {
                            operation: Operation.block_recovery,
                            height: HeightManager.height.toString(),
                            status: Status.Success,
                            responseTime: Number(moment().utc().unix() * 1000),
                        });
                    }
                    resolve();
                } catch (err) {
                    logger.error("Failed to store the payload of a push to the DB: " + err, {
                        operation: Operation.db,
                        height: HeightManager.height.toString(),
                        status: Status.Error,
                        responseTime: Number(moment().utc().unix() * 1000),
                    });
                    reject(err);
                }
            } else if (stored_data.type === "block_header") {
                try {
                    const block_header = BlockHeader.reviver("", stored_data.data);
                    await this.ledger_storage.updateValidatorsByBlockheader(block_header);
                    const updated = await this.ledger_storage.updateBlockHeader(block_header);
                    const put = await this.ledger_storage.putBlockHeaderHistory(block_header, HeightManager.height);
                    await this.emitBoaStats();
                    if (updated)
                        logger.info(
                            `Update a blockHeader : ${block_header.toString()}, ` +
                            `block height : ${block_header.height.toString()}`,
                            {
                                operation: Operation.db,
                                height: block_header.height.toString(),
                                status: Status.Success,
                                responseTime: Number(moment().utc().unix() * 1000),
                            }
                        );
                    if (put)
                        logger.info(
                            `puts a blockHeader history : ${block_header.toString()}, ` +
                            `block height : ${block_header.height.toString()}`,
                            {
                                operation: Operation.db,
                                height: block_header.height.toString(),
                                status: Status.Success,
                                responseTime: Number(moment().utc().unix() * 1000),
                            }
                        );

                    resolve();
                } catch (err) {
                    logger.error("Failed to store the block_header of a update to the DB: " + err, {
                        operation: Operation.db,
                        height: HeightManager.height.toString(),
                        status: Status.Error,
                        responseTime: Number(moment().utc().unix() * 1000),
                    });
                    reject(err);
                }
            } else if (stored_data.type === "pre_image") {
                try {
                    const pre_image = PreImageInfo.reviver("", stored_data.data);
                    const changes = await this.ledger_storage.updatePreImage(pre_image);

                    if (changes)
                        logger.info(
                            `Saved a pre-image utxo : ${pre_image.utxo.toString().substr(0, 18)}, ` +
                            `hash : ${pre_image.hash.toString()}, pre-image height : ${pre_image.height}`,
                            {
                                operation: Operation.db,
                                height: HeightManager.height.toString(),
                                status: Status.Success,
                                responseTime: Number(moment().utc().unix() * 1000),
                            }
                        );
                    resolve();
                } catch (err) {
                    logger.error("Failed to store the payload of a update to the DB: " + err, {
                        operation: Operation.db,
                        height: HeightManager.height.toString(),
                        status: Status.Error,
                        responseTime: Number(moment().utc().unix() * 1000),
                    });
                    reject(err);
                }
            } else if (stored_data.type === "transaction") {
                try {
                    const tx = Transaction.reviver("", stored_data.data);
                    const changes = await this.ledger_storage.putTransactionPool(tx);
                    if (changes) {
                        if (tx.inputs.length > 0) {
                            const tx_hash = hashFull(tx);
                            const utxos = tx.inputs.map((m: TxInput) => m.utxo);
                            const addresses = await this.ledger_storage.getAddressesOfUTXOs(utxos);
                            addresses.forEach((m) =>
                                this.wallet_watcher.onTransactionAccountCreated(m.address, tx_hash, "pending")
                            );
                            await this.emitPendingTransactions(tx, tx_hash);
                        }
                        logger.info(
                            `Saved a transaction hash : ${hashFull(tx).toString()}, ` + `data : ` + stored_data.data,
                            {
                                operation: Operation.db,
                                height: HeightManager.height.toString(),
                                status: Status.Success,
                                responseTime: Number(moment().utc().unix() * 1000),
                            }
                        );
                    }
                    resolve();
                } catch (err) {
                    logger.error("Failed to store the payload of a push to the DB: " + err, {
                        operation: Operation.db,
                        height: HeightManager.height.toString(),
                        status: Status.Error,
                        responseTime: Number(moment().utc().unix() * 1000),
                    });
                    reject(err);
                }
            }
        });
    }

    /**
     * Stoa emit the pending transaction
     * @param transaction The pending tranasction
     * @param tx_hash Hash of the transaction
     * @returns
     */
    public emitPendingTransactions(tx: any, tx_hash: Hash) {
        return new Promise<any>(async (resolve, reject) => {
            let pendingTransaction = [{
                tx_hash: tx_hash.toString(),
                height: "",
                time_stamp: moment.utc().unix(),
                transaction: tx
            }]
            logger.info(`Emitted new Pending Transactions`, {
                operation: Operation.block_sync,
                height: HeightManager.height.toString(),
                status: Status.Success,
                responseTime: Number(moment().utc().unix() * 1000),
            });
            this.socket.io.emit(events.server.newTransaction, pendingTransaction);
            return resolve(pendingTransaction);
        });
    }

    /**
     * Catches up to block height of Agora
     * This is done only once immediately after Stoa is executed.
     * @param height The block height of Agora
     */
    private catchup(height: Height): Promise<void> {
        return new Promise<void>(async (resolve, reject) => {
            try {
                let expected_height = await this.ledger_storage.getExpectedBlockHeight();

                if (JSBI.greaterThanOrEqual(height.value, expected_height.value)) {
                    while (true) {
                        if (await this.recoverBlock(null, height, expected_height)) break;
                        // If the number of blocks to be recovered is too large,
                        // only a part of them will be recovered.
                        // Therefore, the height of the block to start the recovery
                        // is taken from the database.
                        expected_height = await this.ledger_storage.getExpectedBlockHeight();
                    }
                }

                resolve();
            } catch (err) {
                logger.error("Failed to catch up to block height of Agora: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                reject(err);
            }
        });
    }

    private paginate(req: express.Request, res: express.Response): Promise<IPagination> {
        return new Promise<IPagination>((resolve, reject) => {
            let page: number;
            let pageSize: number;

            if (req.query.page !== undefined && Number(req.query.page) !== 0) {
                if (!Utils.isPositiveInteger(req.query.page.toString())) {
                    res.status(400).send(`Invalid value for parameter 'page': ${req.query.page.toString()}`);
                    return;
                }
                page = Number(req.query.page.toString());
            } else page = 1;

            if (req.query.pageSize !== undefined) {
                if (!Utils.isPositiveInteger(req.query.pageSize.toString())) {
                    res.status(400).send(`Invalid value for parameter 'limit': ${req.query.pageSize.toString()}`);
                    return;
                }
                pageSize = Number(req.query.pageSize.toString());
                if (pageSize > this.limit_page_size) {
                    res.status(400).send(`Page size cannot be a number greater than 100: ${pageSize}`);
                    return;
                }
            } else pageSize = 10;

            return resolve({ page, pageSize });
        });
    }

    /**
     * GET /coinmarketchart/
     *
     * Called when a request is received through the `/utxo/` handler
     *
     * Returns BOA statistics of last 24 hours.
     */
    private async getBoaPriceChart(req: express.Request, res: express.Response) {
        const to = await Time.msToTime(Date.now());
        const from = await JSBI.subtract(JSBI.BigInt(to.seconds), JSBI.BigInt(60 * 60 * 24));
        const num = Number(from.toString());
        const currency = String(req.query.currency);
        const dt = new Date(to.seconds * 1000);
        const df = new Date(num * 1000);

        logger.info(`Price chart from: ${df}, to: ${dt} `, {
            operation: Operation.coin_market_data_sync,
            height: HeightManager.height.toString(),
            status: Status.Success,
            responseTime: Number(moment().utc().unix() * 1000),
        });

        this.ledger_storage
            .getCoinMarketChart(Number(from.toString()), to.seconds, currency)
            .then(async (rows: any[]) => {
                if (rows.length === 0) {
                    res.status(204).send("The data does not exist");
                } else {
                    const marketCapChart: IMarketChart[] = [];
                    await rows.forEach((element, index) => {
                        marketCapChart.push({
                            usd_price: element.price,
                            last_updated_at: element.last_updated_at,
                        });
                    });
                    res.status(200).send(marketCapChart);
                }
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                res.send(500).send("Failed to data lookup");
            });
    }

    /**
     *  Stoa emits the latest Boa stats using sockets on new block received.
     * @returns Returns the Promise. If it is finished successfully the `.then`
     * of the returned Promise is called
     * and if an error occurs the `.catch` is called with an error.
     */
    public emitBoaStats(): Promise<IBOAStats> {
        return new Promise<IBOAStats>(async (resolve, reject) => {
            this.ledger_storage
                .getBOAStats()
                .then((data: any[]) => {
                    if (!data[0]) {
                        logger.info("Failed to latest BOA stats", {
                            operation: Operation.db,
                            height: HeightManager.height.toString(),
                            status: Status.Error,
                            responseTime: Number(moment().utc().unix() * 1000),
                        });
                        return;
                    } else {
                        const boaStats: IBOAStats = {
                            height: data[0].height,
                            transactions: data[0].transactions,
                            validators: data[0].validators,
                            frozen_coin: data[0].total_frozen,
                            total_reward: data[0].total_reward,
                            time_stamp: data[0].time_stamp,
                            circulating_supply: data[0].circulating_supply,
                            active_validators: data[0].active_validator,
                        };
                        this.socket.io.emit(events.server.latestStats, boaStats);
                        logger.info(`Emitted Updated BOA stats`, {
                            operation: Operation.db,
                            height: HeightManager.height.toString(),
                            status: Status.Success,
                            responseTime: Number(moment().utc().unix() * 1000),
                        });
                        return resolve(boaStats);
                    }
                })
                .catch((err) => {
                    mailService.mailer(Operation.db, err);
                    logger.error("Failed to latest BOA stats: " + err, {
                        operation: Operation.db,
                        height: HeightManager.height.toString(),
                        status: Status.Error,
                        responseTime: Number(moment().utc().unix() * 1000),
                    });
                    return;
                });
        });
    }

    /**
     *  Stoa emits the updates using sockets on new block received
     * @param block The block to emit
     * @returns Returns the Promise. If it is finished successfully the `.then`
     * of the returned Promise is called
     * and if an error occurs the `.catch` is called with an error.
     */
    public emitBlock(block: Block): Promise<boolean> {
        return new Promise<boolean>(async (resolve, reject) => {
            try {
                await this.emitNewBlock(block);
                resolve(true);
            } catch (err) {
                reject("Failed to emit new block");
            }
        });
    }

    /**
     * Stoa emits the detail of new block received
     * @param block
     * @returns
     */
    public emitNewBlock(block: Block): Promise<IEmitBlock> {
        return new Promise<IEmitBlock>((resolve, reject) => {
            const block_hash = hashFull(block.header);
            const latestBlock: IEmitBlock = {
                height: block.header.height.toString(),
                hash: block_hash.toString(),
                time_stamp: block.header.time_offset + this.genesis_timestamp,
                block,
            };
            logger.info(`Emitted new Block`, {
                operation: Operation.block_sync,
                height: HeightManager.height.toString(),
                status: Status.Success,
                responseTime: Number(moment().utc().unix() * 1000),
            });
            this.socket.io.emit(events.server.newBlock, latestBlock);
            return resolve(latestBlock);
        });
    }

    /* Get BOA Holders
     * @returns Returns BOA Holders of the ledger.
     */
    public async getBoaHolders(req: express.Request, res: express.Response) {
        const pagination: IPagination = await this.paginate(req, res);
        if (req.query.currency === undefined) {
            res.status(400).send(`Parameters 'currency' is not entered.`);
            return;
        }
        const currency: string = String(req.query.currency);
        this.ledger_storage
            .getBOAHolders(pagination.pageSize, pagination.page)
            .then(async (data: any) => {
                if (data.length === 0) {
                    return res.status(204).send(`The data does not exist.`);
                } else {
                    let exchangeRate = await this.ledger_storage.getExchangeRate(currency);
                    let exchange = new Exchange(exchangeRate);
                    const holderList: IBOAHolder[] = [];
                    for (const row of data.holders) {
                        holderList.push({
                            address: row.address,
                            tx_count: row.tx_count,
                            total_received: row.total_received,
                            total_sent: row.total_sent,
                            total_reward: row.total_reward,
                            total_frozen: row.total_frozen,
                            total_spendable: row.total_spendable,
                            total_balance: row.total_balance,
                            percentage: Number((row.total_balance / data.circulating_supply) * 100).toFixed(4),
                            value: exchange.convertAmountToCurrency(new Amount(row.total_balance)),
                            full_count: row.full_count,
                        });
                    }
                    return res.status(200).send(JSON.stringify(holderList));
                }
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                return res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /holder_balance_history/:address
     * Called when a request is received through the `/holder_balance_history/:address` handler
     * The parameter `date` is the start date of the range of dates to look up.
     * @returns Returns average transaction fee between range (date - filter)
     */
    private async getHolderBalanceHistory(req: express.Request, res: express.Response) {
        const address: string = String(req.params.address);

        let filter;
        let filter_end;
        let filter_begin;

        if (req.query.filter === undefined) {
            res.status(400).send(`Parameter filter must also be set.`);
            return;
        } else if (req.query.date === undefined) {
            res.status(400).send(`Parameter endDate must also be set.`);
            return;
        } else {
            if (!Utils.isPositiveInteger(req.query.date.toString())) {
                res.status(400).send(`Invalid value for parameter 'beginDate': ${req.query.date.toString()}`);
                return;
            }

            filter_end = Number(req.query.date.toString());
        }

        filter = req.query.filter.toString();
        filter_end = moment(Number(req.query.date.toString()) * 1000)
            .utc()
            .startOf("D");

        switch (filter) {
            case "D": {
                filter_begin = filter_end.unix() - 86400;
                filter = "H";
                break;
            }
            case "5D": {
                filter_begin = filter_end.unix() - 432000;
                filter = "D";
                break;
            }
            case "M": {
                filter_begin = filter_end.unix() - 2592000;
                filter = "D";
                break;
            }
            case "3M": {
                filter_begin = filter_end.unix() - 7776000;
                filter = "M";
                break;
            }
            case "6M": {
                filter_begin = filter_end.unix() - 15552000;
                filter = "M";
                break;
            }
            case "Y": {
                filter_begin = filter_end.unix() - 31536000;
                filter = "M";
                break;
            }
            case "3Y": {
                filter_begin = filter_end.unix() - 94694400;
                filter = "Y";
                break;
            }
            case "5Y": {
                filter_begin = filter_end.unix() - 157680000;
                filter = "Y";
                break;
            }
            default: {
                filter_begin = filter_end.unix() - 86400;
                filter = "H";
                break;
            }
        }
        this.ledger_storage
            .getAccountChart(address, filter_begin, moment(filter_end).startOf("D").unix(), filter)
            .then((data: any) => {
                if (data === undefined) {
                    res.status(500).send("Failed to data lookup");
                    return;
                } else if (data.length === 0) {
                    return res.status(204).send(`The data does not exist.`);
                } else {
                    const accountChartList: IAccountChart[] = [];
                    for (const row of data) {
                        accountChartList.push({
                            address: row.address,
                            granularity: row.granularity,
                            granularity_time_stamp: row.granularity_time_stamp,
                            time_stamp: row.time_stamp,
                            balance: row.balance,
                            block_height: row.block_height,
                        });
                    }
                    return res.status(200).send(JSON.stringify(accountChartList));
                }
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to averageFeeChart data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                res.send(500).send("Failed to data lookup");
            });
    }

    /* Get BOA Holder
     * @returns Returns BOA Holder of the ledger.
     */
    public async getBoaHolder(req: express.Request, res: express.Response) {
        const currency: string = String(req.query.currency);
        if (currency === undefined) {
            res.status(400).send(`Parameters 'currency' is not entered.`);
            return;
        }
        if (req.params.address === undefined) {
            res.status(400).send(`Parameters 'address' is not entered.`);
            return;
        }
        const address = req.params.address.toString();
        if (PublicKey.validate(address) !== '') {
            res.status(400).send(`Invalid value for parameter 'address': ${address}`);
            return;
        }
        this.ledger_storage
            .getBOAHolder(address)
            .then(async (data: any) => {
                if (data.length === 0) {
                    return res.status(204).send(`The data does not exist.`);
                } else {
                    let exchangeRate = await this.ledger_storage.getExchangeRate(currency);
                    let exchange = new Exchange(exchangeRate);
                    const holder: IBOAHolder = {
                        address: data.holder[0].address,
                        tx_count: data.holder[0].tx_count,
                        total_received: data.holder[0].total_received,
                        total_sent: data.holder[0].total_sent,
                        total_reward: data.holder[0].total_reward,
                        total_frozen: data.holder[0].total_frozen,
                        total_spendable: 0,
                        total_balance: data.holder[0].total_balance,
                        percentage: Number((data.holder[0].total_balance / data.circulating_supply) * 100).toFixed(4),
                        value: exchange.convertAmountToCurrency(new Amount(data.holder[0].total_balance)),
                    };
                    return res.status(200).send(JSON.stringify(holder));
                }
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                return res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /voting-details/
     * Called when a request is received through the `/voting-details/` handler
     * The parameter `hash` is the hash of  transaction
     * Returns list of proposal voting details
     */
    public async getVotingDetails(req: express.Request, res: express.Response) {
        const pagination: IPagination = await this.paginate(req, res);
        if (req.params.proposal_id === undefined) {
            res.status(400).send(`Parameters 'proposal_id' is not entered.`);
            return;
        }
        const proposal_id = req.params.proposal_id.toString();
        this.ledger_storage
            .getVotingDetails(proposal_id, pagination.pageSize, pagination.page)
            .then((data: any[]) => {
                const proposal_votingDetails: IVotingDetails[] = [];
                for (const row of data) {
                    proposal_votingDetails.push({
                        address: row.voter_address.toString(),
                        sequence: row.sequence,
                        hash: new Hash(row.tx_hash, Endian.Little).toString(),
                        ballot_answer: row.ballot_answer == null ? "" : ConvertTypes.ballotAddressToString(row.ballot_answer),
                        voting_time: row.voting_time,
                        voter_utxo_key: new Hash(row.utxo_key, Endian.Little).toString(),
                        full_count: row.full_count,
                    });
                }
                return res.status(200).send(JSON.stringify(proposal_votingDetails));
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to hash search data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /validator/missed-blocks/
     * Called when a request is received through the `validator/missed-blocks/` handler
     * The parameter `address` is the address of  validator
     * Returns list of validator missed blocks
     */
    public async getValidatorMissedBlocks(req: express.Request, res: express.Response) {
        if (req.params.address === undefined) {
            res.status(400).send(`Parameters 'address' is not entered.`);
            return;
        }
        const address = req.params.address.toString();
        if (PublicKey.validate(address) !== '') {
            res.status(400).send(`Invalid value for parameter 'address': ${address}`);
            return;
        }
        this.ledger_storage
            .getValidatorMissedBlocks(address)
            .then((data: any[]) => {
                return res.status(200).send(JSON.stringify(data));
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to hash search data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /block/validators
     * The parameter `height` is the height and `hash` is the hash of block
     * Returns a set of Validators based on the block height.
     */
    public async getBlockValidators(req: express.Request, res: express.Response) {
        let field: string;
        let value: number | Buffer;
        // Validating Parameter - height
        if (req.query.height !== undefined) {
            if (!Utils.isPositiveInteger(req.query.height.toString())) {
                res.status(400).send(`Invalid value for parameter 'height': ${req.query.height}`);
                return;
            }
            field = "height";
            value = Number(req.query.height);
        }
        // Validating Parameter - hash
        else if (req.query.hash !== undefined) {
            field = "hash";
            try {
                value = new Hash(req.query.hash.toString()).toBinary(Endian.Little);
            } catch (error) {
                res.status(400).send(`Invalid value for parameter 'hash': ${req.query.hash}`);
                return;
            }
        } else {
            res.status(400).send(`Parameters 'height' or 'hash' are not entered.`);
            return;
        }
        let pageSize: number | undefined;
        let page: number | undefined;
        if (req.query.pageSize !== undefined && req.query.page !== undefined) {
            const pagination: IPagination = await this.paginate(req, res);
            pageSize = pagination.pageSize;
            page = pagination.page
        }
        else {
            pageSize = undefined;
            page = undefined;
        }
        this.ledger_storage
            .getBlockValidators(value, field, pageSize, page)
            .then((rows: any[]) => {
                // Nothing found
                if (!rows.length) {
                    res.status(204).send(`The data does not exist. 'height': (${value})`);
                    return;
                }
                const out_put: IBlockValidator[] = [];
                for (const row of rows) {
                    const preimage_hash: string = row.preimage_hash !== null ? new Hash(row.preimage_hash, Endian.Little).toString() : "";
                    const preimage_height_str: string = row.preimage_height !== null ? row.preimage_height.toString() : "";

                    const preimage: IPreimage = {
                        height: preimage_height_str,
                        hash: preimage_hash,
                    };
                    const validator: IBlockValidator = {
                        address: row.address,
                        utxo_key: new Hash(row.stake, Endian.Little).toString(),
                        pre_image: preimage,
                        slashed: row.slashed,
                        block_signed: row.signed,
                        full_count: row.full_count
                    };
                    out_put.push(validator);
                }
                res.status(200).send(JSON.stringify(out_put));
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /* Get transaction hash
     * @returns Returns transaction hash according to utxo
     */
    public async getTransactionHash(req: express.Request, res: express.Response) {
        const req_utxo: string = String(req.params.utxo);
        let utxo: Hash;
        try {
            utxo = new Hash(req_utxo);
        } catch (error) {
            res.status(400).send(`Invalid value for parameter 'utxo': ${req_utxo}`);
            return;
        }
        this.ledger_storage
            .getTransactionHash(utxo)
            .then((data: any) => {
                if (data.length === 0) {
                    return res.status(500).send("Failed to data lookup");
                } else {
                    const tx_hash = new Hash(data[0].tx_hash, Endian.Little).toString();
                    return res.status(200).send(JSON.stringify(tx_hash));
                }
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                return res.status(500).send("Failed to data lookup");
            });
    }

    /* Get all proposals
     * @returns Returns proposals of the ledger.
     */
    public async getProposals(req: express.Request, res: express.Response) {
        const pagination: IPagination = await this.paginate(req, res);
        this.ledger_storage
            .getProposals(pagination.pageSize, pagination.page)
            .then((data: any) => {
                if (data.proposalData.length === 0) {
                    return res.status(204).send(`The data does not exist.`);
                } else {
                    let proposals: IProposalList[] = [];
                    for (const row of data.proposalData) {
                        proposals.push({
                            proposal_id: row.proposal_id,
                            proposal_title: row.proposal_title,
                            proposal_type: ConvertTypes.ProposalTypetoString(row.proposal_type),
                            block_height: row.block_height,
                            fund_amount: row.fund_amount,
                            vote_start_height: row.vote_start_height,
                            vote_end_height: row.vote_end_height,
                            proposal_status: row.proposal_status,
                            proposal_date: row.submit_time,
                            proposer_name: row.proposer_name,
                            voting_start_date: row.voting_start_date,
                            voting_end_date: row.voting_end_date,
                            full_count: row.full_count,
                            total_validators: row.total_validators,
                            yes_percentage: Number(row.yes_percent).toFixed(2),
                            no_percentage: Number(row.no_percent).toFixed(2),
                            abstain_percentage: Number(row.abstain_percent).toFixed(2),
                            not_voted_percentage: Number(row.not_voted_percent).toFixed(2),
                            voted_percentage: Number(row.voted_percent).toFixed(2),
                            proposal_result: row.proposal_result,
                        });
                    }
                    return res.status(200).send(JSON.stringify(proposals));
                }
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                return res.status(500).send("Failed to data lookup");
            });
    }

    /* Get proposal by id
     * @returns Returns proposal of the ledger.
     */
    public async getProposalById(req: express.Request, res: express.Response) {
        const proposal_id: string = String(req.params.proposal_id);
        if (proposal_id.trim().length === 0) {
            res.status(400).send(`Parameter proposal id must be set.`);
            return;
        }
        this.ledger_storage
            .getProposalById(proposal_id)
            .then((data: any) => {
                if (data.proposalData.length === 0) {
                    return res.status(204).send(`The data does not exist.`);
                } else {
                    const proposal: IProposalAPI = {
                        proposal_title: data.proposalData[0].proposal_title,
                        proposal_id: data.proposalData[0].proposal_id,
                        detail: data.proposalData[0].detail,
                        proposal_tx_hash: new Hash(data.proposalData[0].tx_hash, Endian.Little).toString(),
                        fee_tx_hash: new Hash(data.proposalData[0].voting_fee_hash, Endian.Little).toString(),
                        proposer_name: data.proposalData[0].proposer_name,
                        block_height: data.proposalData[0].block_height,
                        fund_amount: data.proposalData[0].fund_amount,
                        proposal_fee: data.proposalData[0].proposal_fee,
                        proposal_type: ConvertTypes.ProposalTypetoString(data.proposalData[0].proposal_type),
                        vote_start_height: data.proposalData[0].vote_start_height,
                        voting_start_date: data.proposalData[0].voting_start_date,
                        vote_end_height: data.proposalData[0].vote_end_height,
                        voting_end_date: data.proposalData[0].voting_end_date,
                        proposal_status: data.proposalData[0].proposal_status,
                        proposal_result: data.proposalData[0].proposal_result,
                        proposal_date: data.proposalData[0].submit_time,
                        pre_evaluation_start_time: data.proposalData[0].pre_evaluation_start_time,
                        pre_evaluation_end_time: data.proposalData[0].pre_evaluation_end_time,
                        ave_pre_evaluation_score: data.proposalData[0].ave_pre_evaluation_score,
                        proposer_address: data.proposalData[0].proposer_address,
                        proposal_fee_address: data.proposalData[0].proposal_fee_address,
                        urls: data.url,
                        total_validators: data.total_validators,
                        total_yes_voted: data.yes,
                        total_no_voted: data.no,
                        total_abstain_voted: data.abstain,
                        total_not_voted: data.not_voted,
                        yes_percentage: Number(data.yes_percent).toFixed(2),
                        no_percentage: Number(data.no_percent).toFixed(2),
                        abstain_percentage: Number(data.abstain_percent).toFixed(2),
                        not_voted_percentage: Number(data.not_voted_percent).toFixed(2),
                        voted_percentage: Number(data.voted_percent).toFixed(2),
                        total_voted: data.voted
                    }
                    return res.status(200).send(JSON.stringify(proposal));
                }
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                return res.status(500).send("Failed to data lookup");
            });
    }

    /* Get validator reward
     * @returns Returns reward of the validators.
     */
    public async getValidatorReward(req: express.Request, res: express.Response) {
        if (req.params.address === undefined) {
            res.status(400).send(`Parameters 'address' is not entered.`);
            return;
        }
        const address = req.params.address.toString();
        if (PublicKey.validate(address) !== "") {
            res.status(400).send(`Invalid value for parameter 'address': ${address}`);
            return;
        }
        const pagination: IPagination = await this.paginate(req, res);
        this.ledger_storage
            .getValidatorReward(address, pagination.pageSize, pagination.page)
            .then((data: any[]) => {
                if (data.length === 0) {
                    return res.status(204).send(`The data does not exist.`);
                } else {
                    let rewards: IValidatorReward[] = [];
                    for (const row of data) {
                        rewards.push({
                            block_height: row.block_height,
                            steaking_amount: row.stake_amount ? row.stake_amount : 0,
                            block_reward: row.total_reward,
                            block_fee: row.total_fee,
                            validator_reward: row.validator_reward,
                            full_count: row.full_count,
                        });
                    }
                    return res.status(200).send(JSON.stringify(rewards));
                }
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                return res.status(500).send("Failed to data lookup");
            });
    }

    /* Get /validator/ballots
     * The parameter `address` of the validator
     * @returns Returns validator ballots of the ledger.
     */
    public async getValidatorBallots(req: express.Request, res: express.Response) {
        if (req.params.address === undefined) {
            res.status(400).send(`Parameters 'address' is not entered.`);
            return;
        }
        const address = req.params.address.toString();
        if (PublicKey.validate(address) !== "") {
            res.status(400).send(`Invalid value for parameter 'address': ${address}`);
            return;
        }
        const pagination: IPagination = await this.paginate(req, res);
        this.ledger_storage
            .getValidatorBallots(address, pagination.pageSize, pagination.page)
            .then((data: any[]) => {
                if (data.length === 0) {
                    return res.status(204).send(`The data does not exist.`);
                } else {
                    const ballots: IBallotAPI[] = [];
                    for (const row of data) {
                        ballots.push({
                            proposal_id: row.proposal_id,
                            tx_hash: new Hash(row.tx_hash, Endian.Little).toString(),
                            sequence: row.sequence,
                            proposal_type: ConvertTypes.ProposalTypetoString(row.proposal_type),
                            proposal_title: row.proposal_title,
                            ballot_answer: row.ballot_answer == null ? "" : ConvertTypes.ballotAddressToString(row.ballot_answer),
                            full_count: row.full_count
                        });
                    }
                    return res.status(200).send(JSON.stringify(ballots));
                }
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                return res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /average_fee_chart
     * Called when a request is received through the `/average_fee_chart` handler
     * The parameter `date` is the start date of the range of dates to look up.
     * @returns Returns average transaction fee between range (date - filter)
     */
    private async averageFeeChart(req: express.Request, res: express.Response) {
        let filter;
        let filter_end;
        let filter_begin;

        if (req.query.filter === undefined) {
            res.status(400).send(`Parameter filter must also be set.`);
            return;
        } else if (req.query.date === undefined) {
            res.status(400).send(`Parameter endDate must also be set.`);
            return;
        } else {
            if (!Utils.isPositiveInteger(req.query.date.toString())) {
                res.status(400).send(`Invalid value for parameter 'beginDate': ${req.query.date.toString()}`);
                return;
            }
            filter_end = Number(req.query.date.toString());
        }

        filter = req.query.filter.toString();
        filter_end = moment(Number(req.query.date.toString()) * 1000)
            .utc()
            .startOf("D");

        switch (filter) {
            case "D": {
                filter_begin = filter_end.unix() - 86400;
                filter = "H";
                break;
            }
            case "5D": {
                filter_begin = filter_end.unix() - 432000;
                filter = "D";
                break;
            }
            case "M": {
                filter_begin = filter_end.unix() - 2592000;
                filter = "D";
                break;
            }
            case "3M": {
                filter_begin = filter_end.unix() - 7776000;
                filter = "M";
                break;
            }
            case "6M": {
                filter_begin = filter_end.unix() - 15552000;
                filter = "M";
                break;
            }
            case "Y": {
                filter_begin = filter_end.unix() - 31536000;
                filter = "M";
                break;
            }
            case "3Y": {
                filter_begin = filter_end.unix() - 94694400;
                filter = "Y";
                break;
            }
            case "5Y": {
                filter_begin = filter_end.unix() - 157680000;
                filter = "Y";
                break;
            }
            default: {
                filter_begin = filter_end.unix() - 86400;
                filter = "H";
                break;
            }
        }

        this.ledger_storage
            .calculateAvgFeeChart(filter_begin, moment(filter_end).startOf("D").unix(), filter)
            .then((data: any) => {
                if (data === undefined) {
                    res.status(500).send("Failed to data lookup");
                    return;
                } else if (data.length === 0) {
                    return res.status(204).send(`The data does not exist.`);
                } else {
                    const avgFeelist: IAvgFee[] = [];
                    for (const row of data) {
                        avgFeelist.push({
                            height: row.height,
                            granularity: row.granularity,
                            granularity_time_stamp: row.granularity_time_stamp,
                            time_stamp: row.time_stamp,
                            average_tx_fee: row.average_tx_fee,
                            total_tx_fee: row.total_tx_fee,
                            total_payload_fee: row.total_payload_fee,
                            total_fee: row.total_fee,
                        });
                    }
                    return res.status(200).send(JSON.stringify(avgFeelist));
                }
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to averageFeeChart data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                res.send(500).send("Failed to data lookup");
            });
    }

    /**
     * The method to get the proposal with data collection status as pending
     */
    public getPendingProposal(): Promise<IPendingProposal[]> {
        return new Promise<IPendingProposal[]>((resolve, reject) => {
            this.ledger_storage
                .getPendingProposal()
                .then((data: any[]) => {
                    const proposals: IPendingProposal[] = [];
                    for (const row of data) {
                        proposals.push({
                            app_name: row.app_name.toString(),
                            proposal_id: row.proposal_id.toString(),
                            proposal_type: row.proposal_type,
                            proposal_title: row.proposal_title,
                            vote_start_height: row.vote_start_height,
                            vote_end_height: row.vote_end_height,
                            doc_hash: new Hash(row.doc_hash, Endian.Little),
                            fund_amount: JSBI.BigInt(row.fund_amount),
                            proposal_fee: JSBI.BigInt(row.proposal_fee),
                            vote_fee: JSBI.BigInt(row.vote_fee),
                            proposal_fee_tx_hash: new Hash(row.proposal_fee_tx_hash, Endian.Little),
                            proposer_address: row.proposer_address,
                            proposal_fee_address: row.proposal_fee_address,
                        });
                    }
                    resolve(proposals);
                })
                .catch((err) => {
                    reject(err);
                });
        });
    }

    /**
     * GET /search/hash
     * Called when a request is received through the `/search/hash` handler
     * The parameter `hash` is the hash of block or transaction
     * Returns block as true if hash matches block hash or transaction as true if hash matches tx_hash
     * otherwise it will respond with no data found.
     */
    private searchHash(req: express.Request, res: express.Response) {
        const req_hash: string = String(req.params.hash);

        let search_hash: Hash;
        try {
            search_hash = new Hash(req_hash);
        } catch (error) {
            res.status(400).send(`Invalid value for parameter 'hash': ${req_hash}`);
            return;
        }

        this.ledger_storage
            .exist(search_hash)
            .then((data: any) => {
                if (data === undefined) {
                    res.status(500).send("Failed to data lookup");
                    return;
                } else {
                    if (!(data[0].block || data[0].transaction)) {
                        return res.status(204).send(`The data does not exist. 'hash': (${hash})`);
                    }
                    return res.status(200).send(JSON.stringify(data[0]));
                }
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to hash search data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /convert-to-currency
     * Called when a request is received through the `/convert-to-currency` handler
     * The parameter `amount` is the Boa amount.
     * The parameter `currency` is the currency.
     * @returns Returns the USD amount against input BOA amount.
     */
    public async convertToCurrency(req: express.Request, res: express.Response) {
        if (req.query.currency === undefined) {
            res.status(400).send(`Parameters 'currency' is not entered.`);
            return;
        }
        let amount: number;
        const currency: string = String(req.query.currency);

        if (req.query.amount === undefined) {
            res.status(400).send(`Parameters 'amount' is not entered.`);
            return;
        } else if (0 > Number(req.query.amount.toString())) {
            res.status(400).send(`Invalid value for parameter 'amount': ${req.query.amount.toString()}`);
            return;
        }
        amount = Number(req.query.amount);
        this.ledger_storage
            .getExchangeRate(currency)
            .then((rate: number) => {
                let exchange = new Exchange(rate);
                let currencyAmount = exchange.convertBoaToCurrency(amount)
                return res.status(200).send({ amount: amount, currency: currencyAmount });
            })
            .catch((err) => {
                mailService.mailer(Operation.db, err);
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    status: Status.Error,
                    responseTime: Number(moment().utc().unix() * 1000),
                });
                return res.status(204).send(`The exchange rate does not exist.`);
            });
    }

    /**
     * Get the maximum number of blocks that can be recovered at one time
     */
    get max_count_on_recovery(): number {
        return this._max_count_on_recovery;
    }

    /**
     * Set the maximum number of blocks that can be recovered at one time
     */
    set max_count_on_recovery(value: number) {
        this._max_count_on_recovery = value;
    }
}

/**
 * The interface of the data that are temporarily stored in the pool
 */
interface IPooledData {
    type: string;
    data: any;
}

export default Stoa;
