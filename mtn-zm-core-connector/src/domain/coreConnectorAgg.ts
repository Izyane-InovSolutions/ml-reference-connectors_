/*****
 License
 --------------
 Copyright © 2017 Bill & Melinda Gates Foundation
 The Mojaloop files are made available by the Bill & Melinda Gates Foundation under the Apache License, Version 2.0 (the "License") and you may not use these files except in compliance with the License. You may obtain a copy of the License at

 http://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, the Mojaloop files are distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.

 Contributors
 --------------
 This is the official list (alphabetical ordering) of the Mojaloop project contributors for this file.
 Names of the original copyright holders (individuals or organizations)
 should be listed with a '*' in the first column. People who have
 contributed from an organization can be listed under the organization
 that actually holds the copyright for their contributions (see the
 Gates Foundation organization for an example). Those individuals should have
 their names indented and be marked with a '-'. Email address can be added
 optionally within square brackets <email>.


 - Niza Tembo <mcwayzj@gmail.com>
 - Okello Ivan Elijah <elijahokello90@gmail.com>

 --------------
 ******/

'use strict';

import { randomUUID } from 'crypto';
import config from '../config';

import {
    IMTNClient,
    TMTNConfig,
    TMTNDisbursementRequestBody,
    PartyType,
    MTNError,
    ETransactionStatus,
    TMTNSendMoneyRequest,
    TMTNSendMoneyResponse,
    TMTNCollectMoneyRequest,
    TMTNUpdateSendMoneyRequest,
} from './CBSClient';
import {
    ILogger,
    TLookupPartyInfoResponse,
    TQuoteResponse,
    TQuoteRequest,
    TtransferResponse,
    TtransferRequest,
    TtransferPatchNotificationRequest,
    TupdateSendMoneyDeps,
    ValidationError,
    THttpResponse,
    TtransactionEnquiryDeps,
} from './interfaces';
import {
    ISDKClient,
    SDKClientError,
    TSDKOutboundTransferRequest,
    TSDKOutboundTransferResponse,
    TtransferContinuationResponse,
} from './SDKClient';

export class CoreConnectorAggregate {
    public IdType: string;
    private logger: ILogger;
    DATE_FORMAT = 'dd MM yy';

    constructor(
        private readonly sdkClient: ISDKClient,
        private readonly mtnClient: IMTNClient,
        private readonly mtnConfig: TMTNConfig,
        logger: ILogger,
    ) {
        // todo: set the IdType from here 
        this.IdType = "MSISDN";
        this.logger = logger;
    }

    private async checkAccountBarred(msisdn: string): Promise<void> {
        const res = await this.mtnClient.getKyc({ msisdn: msisdn });
        if (res.status == "NOT FOUND") {
            throw ValidationError.accountBarredError();
        }
    }
    private validateQuote(transfer: TtransferRequest): boolean {
        // todo define implmentation
        this.logger.info(`Validating code for transfer with amount ${transfer.amount}`);
        return true;
    }

    private validatePatchQuote(transfer: TtransferPatchNotificationRequest): boolean {
        this.logger.info(`Validating code for transfer with state ${transfer.currentState}`);
        // todo define implmentation
        return true;
    }


    //Payee
    async getParties(id: string, idType: string): Promise<TLookupPartyInfoResponse> {
        this.logger.info(`Get Parties for ${id}`);
        if (!(idType === config.get("mtn.SUPPORTED_ID_TYPE"))) {
            throw ValidationError.unsupportedIdTypeError();
        }

        const lookupRes = await this.mtnClient.getKyc({ msisdn: id });
        const party = {
            data: {
                displayName: `${lookupRes.given_name} ${lookupRes.family_name}`,
                firstName: lookupRes.given_name,
                idType: config.get("mtn.SUPPORTED_ID_TYPE"),
                idValue: id,
                lastName: lookupRes.family_name,
                middleName: " ",
                type: PartyType.CONSUMER,
                kycInformation: `${JSON.stringify(lookupRes)}`,
            },
            statusCode: Number(lookupRes.status),
        };
        this.logger.info(`Party found`, { party });
        return party;
    }

    async quoteRequest(quoteRequest: TQuoteRequest): Promise<TQuoteResponse> {
        this.logger.info(`Quote requests for ${this.IdType} ${quoteRequest.to.idValue}`);
        if (quoteRequest.to.idType !== this.IdType) {
            throw ValidationError.unsupportedIdTypeError();
        }

        if (quoteRequest.currency !== config.get("mtn.X_CURRENCY")) {
            throw ValidationError.unsupportedCurrencyError();
        }

        const res = await this.mtnClient.getKyc({
            msisdn: quoteRequest.to.idValue,

        });

        if (res.status == "NOT FOUND") {
            throw MTNError.payeeBlockedError("Account is barred ", 500, "5400");
        }

        const serviceCharge = config.get("mtn.SERVICE_CHARGE");

        this.checkAccountBarred(quoteRequest.to.idValue);

        const quoteExpiration = config.get("mtn.EXPIRATION_DURATION");
        const expiration = new Date();
        expiration.setHours(expiration.getHours() + Number(quoteExpiration));
        const expirationJSON = expiration.toJSON();

        return {
            expiration: expirationJSON,
            payeeFspCommissionAmount: '0',
            payeeFspCommissionAmountCurrency: quoteRequest.currency,
            payeeFspFeeAmount: serviceCharge,
            payeeFspFeeAmountCurrency: quoteRequest.currency,
            payeeReceiveAmount: quoteRequest.amount,
            payeeReceiveAmountCurrency: quoteRequest.currency,
            quoteId: quoteRequest.quoteId,
            transactionId: quoteRequest.transactionId,
            transferAmount: quoteRequest.amount,
            transferAmountCurrency: quoteRequest.currency,
        };
    }


    async receiveTransfer(transfer: TtransferRequest): Promise<TtransferResponse> {
        this.logger.info(`Transfer for  ${this.IdType} ${transfer.to.idValue}`);
        if (transfer.to.idType != this.IdType) {
            throw ValidationError.unsupportedIdTypeError();
        }
        if (transfer.currency !== config.get("mtn.X_CURRENCY")) {
            throw ValidationError.unsupportedCurrencyError();
        }
        if (!this.validateQuote(transfer)) {
            throw ValidationError.invalidQuoteError();
        }

        this.checkAccountBarred(transfer.to.idValue);
        return {
            completedTimestamp: new Date().toJSON(),
            homeTransactionId: transfer.transferId,
            transferState: 'RESERVED',
        };
    }

    
    async updateTransfer(updateTransferPayload: TtransferPatchNotificationRequest, transferId: string): Promise<void> {
        this.logger.info(`Committing The Transfer with id ${transferId}`);
        if (updateTransferPayload.currentState !== 'COMPLETED') {
            throw ValidationError.transferNotCompletedError();
        }
        if (!this.validatePatchQuote(updateTransferPayload)) {
            throw ValidationError.invalidQuoteError();
        }
        const mtnDisbursementRequest: TMTNDisbursementRequestBody = this.getDisbursementRequestBody(updateTransferPayload);
        await this.mtnClient.sendMoney(mtnDisbursementRequest);
    }

    
    private getDisbursementRequestBody(requestBody: TtransferPatchNotificationRequest): TMTNDisbursementRequestBody {
        if (!requestBody.quoteRequest) {
            throw ValidationError.quoteNotDefinedError('Quote Not Defined Error', '5000', 500);
        }
        return {
           "amount": String(requestBody.quoteRequest.body.amount),
           "currency": this.mtnConfig.X_CURRENCY,
           "externalId" : requestBody.quoteRequest.body.transactionId,
           "payee": {
           "partyIdType": requestBody.quoteRequest.body.payee.partyIdInfo.partyIdType,
            "partyId": requestBody.quoteRequest.body.payee.partyIdInfo.partyIdentifier
           },
           "payerMessage": "Payer Attached Note For Transactions",
           "payeeNote" : "Sending Money"

        };

    }

    private getTMTNSendMoneyResponse(transfer: TSDKOutboundTransferResponse): TMTNSendMoneyResponse {
        this.logger.info(`Getting response for transfer with Id ${transfer.transferId}`);
        return {
            "payeeDetails": {
                "idType": transfer.to.idType,
                "idValue":transfer.to.idValue,
                "fspId": transfer.to.fspId !== undefined ? transfer.to.fspId : "No FSP ID Returned",
                "firstName": transfer.to.firstName !== undefined ? transfer.to.firstName : "No First Name Returned",
                "lastName":transfer.to.lastName !== undefined ? transfer.to.lastName : "No Last Name Returned",
                "dateOfBirth":transfer.to.dateOfBirth !== undefined ? transfer.to.dateOfBirth : "No Date of Birth Returned",
            },
            "receiveAmount": transfer.quoteResponse?.body.payeeReceiveAmount?.amount !== undefined ? transfer.quoteResponse.body.payeeReceiveAmount.amount : "No payee receive amount",
            "receiveCurrency": transfer.fxQuotesResponse?.body.conversionTerms.targetAmount.currency !== undefined ? transfer.fxQuotesResponse?.body.conversionTerms.targetAmount.currency : "No Currency returned from Mojaloop Connector" ,
            "fees": transfer.quoteResponse?.body.payeeFspFee?.amount !== undefined ? transfer.quoteResponse?.body.payeeFspFee?.amount : "No fee amount returned from Mojaloop Connector",
            "feeCurrency": transfer.fxQuotesResponse?.body.conversionTerms.targetAmount.currency !== undefined ? transfer.fxQuotesResponse?.body.conversionTerms.targetAmount.currency : "No Fee currency retrned from Mojaloop Connector",
            "transactionId": transfer.transferId !== undefined ? transfer.transferId : "No transferId returned",
        };
    }

    private validateConversionTerms(transferResponse: TSDKOutboundTransferResponse): boolean {
        this.logger.info(`Validating Conversion Terms with transfer response amount${transferResponse.amount}`);
        // todo: Define Implementations
        return true;
    }

    private validateReturnedQuote(transferResponse: TSDKOutboundTransferResponse): boolean {
        this.logger.info(`Validating Retunred Quote with transfer response amount${transferResponse.amount}`);
        // todo: Define Implementations
        return true;
    }


    private async getTSDKOutboundTransferRequest(transfer: TMTNSendMoneyRequest): Promise<TSDKOutboundTransferRequest> {
        const res = await this.mtnClient.getKyc({
            msisdn: transfer.payerAccount
        });
        return {
            'homeTransactionId': randomUUID(),
            'from': {
                'idType': this.mtnConfig.SUPPORTED_ID_TYPE,
                'idValue': transfer.payerAccount,
                'fspId': this.mtnConfig.FSP_ID,
                "displayName": `${res.given_name} ${res.family_name}`,
                "firstName": res.given_name,
                "middleName": res.given_name,
                "lastName": res.family_name,
                "merchantClassificationCode": "123",
            },
            'to': {
                'idType': transfer.payeeIdType,
                'idValue': transfer.payeeId
            },
            'amountType': 'SEND',
            'currency': transfer.sendCurrency,
            'amount': transfer.sendAmount,
            'transactionType': transfer.transactionType,
        };
    }

    // Payer
    async sendTransfer(transfer: TMTNSendMoneyRequest): Promise<TMTNSendMoneyResponse> {
        this.logger.info(`Transfer from mtn account with ID${transfer.payerAccount}`);

        const transferRequest: TSDKOutboundTransferRequest = await this.getTSDKOutboundTransferRequest(transfer);
        const res = await this.sdkClient.initiateTransfer(transferRequest);
        let acceptRes: THttpResponse<TtransferContinuationResponse>;

        if (res.data.currentState === 'WAITING_FOR_CONVERSION_ACCEPTANCE') {
            if (!this.validateConversionTerms(res.data)) {
                if (!res.data.transferId) {
                    throw ValidationError.transferIdNotDefinedError("Transfer Id not defined in transfer response", "4000", 500);
                }
                acceptRes = await this.sdkClient.updateTransfer({
                    "acceptConversion": false
                }, res.data.transferId);
                throw ValidationError.invalidConversionQuoteError("Recieved Conversion Terms are invalid", "4000", 500);
            }
            else {
                if (!res.data.transferId) {
                    throw ValidationError.transferIdNotDefinedError("Transfer Id not defined in transfer response", "4000", 500);
                }
                acceptRes = await this.sdkClient.updateTransfer({
                    "acceptConversion": true
                }, res.data.transferId);
            }

            if (!this.validateReturnedQuote(acceptRes.data)) {
                throw ValidationError.invalidReturnedQuoteError();
            }
            return this.getTMTNSendMoneyResponse(acceptRes.data);
        }
        if (!this.validateReturnedQuote(res.data)) {
            throw ValidationError.invalidReturnedQuoteError();
        }
        return this.getTMTNSendMoneyResponse(res.data);
    }



    private async checkTransactionAndRespondToMojaloop(deps:TtransactionEnquiryDeps): Promise<THttpResponse<TtransferContinuationResponse>>{
        this.logger.info("Checking transaction and responding mojaloop");
        let sdkRes: THttpResponse<TtransferContinuationResponse> | undefined = undefined;
        let counter = 0;
        while (deps.transactionEnquiry.status === ETransactionStatus.PENDING) {
            this.logger.info(`Waiting for transaction status`);
            if(counter>1){
                this.logger.info(`Checking timed out. Transaction is unsuccessful,Responding with false`);
                sdkRes = await this.sdkClient.updateTransfer({
                    acceptQuote: true, //todo: fix back after demo
                }, deps.transferId);
                break;
            }
            // todo: make the number of seconds configurable
            await new Promise(r => setTimeout(r, this.mtnConfig.TRANSACTION_ENQUIRY_WAIT_TIME));
            deps.transactionEnquiry = await this.mtnClient.getCollectionTransactionEnquiry({
                transactionId: deps.transferId
            });

            if (deps.transactionEnquiry.status === ETransactionStatus.SUCCESSFUL) {
                this.logger.info(`Transaction is successful, Responding with true`);
                sdkRes = await this.sdkClient.updateTransfer({
                    acceptQuote: deps.transferAccept.acceptQuote
                },deps.transferId);
                break;
            } else if (deps.transactionEnquiry.status === ETransactionStatus.FAILED) {
                this.logger.info(`Transaction is unsuccessful,Responding with false`);
                sdkRes = await this.sdkClient.updateTransfer({
                    acceptQuote: true, //todo: fix back after demo
                }, deps.transferId);
                break;
            }
            counter+=1;
        }
        if (!sdkRes) {
            throw SDKClientError.updateTransferRequestNotDefinedError();
        }
        return sdkRes;
    }

    updatesendMoney(updateSendMoneyDeps: TupdateSendMoneyDeps): Promise<TtransferContinuationResponse> {
        this.logger.info(`${updateSendMoneyDeps.transferId}`);
        throw new Error('Method not implemented.');
    }

    private getTMTNCollectMoneyRequest(collection: TMTNUpdateSendMoneyRequest): TMTNCollectMoneyRequest {
        return {
            "amount": collection.amount,
            "currency": this.mtnConfig.X_CURRENCY,
            "externalId": randomUUID(),
            "payer" :{
                "partyId": collection.msisdn,
                "partyIdType": "MSISDN",
            },
            "payerMessage": "Payer Message",
            "payeeNote": "Payee Note"
        };
    }

    // async updateSentTransfer(transferAccept: TMTNUpdateSendMoneyRequest, transferId: string): Promise<TtransferContinuationResponse> {
    //     this.logger.info(`Updating transfer for id ${transferAccept.msisdn} and transfer id ${transferId}`);

    //     if (!(transferAccept.acceptQuote)) {
    //         throw ValidationError.quoteNotAcceptedError();
    //     }
    //     const mtnRes = await this.mtnClient.collectMoney(this.getTMTNCollectMoneyRequest(transferAccept)); // todo fix this back to have the transferId
      
    //     // Transaction id from response 
    //     const transactionEnquiry = await this.mtnClient.getCollectionTransactionEnquiry({
    //         transactionId: mtnRes.financialTransactionId
    //     });


    //     const sdkRes: THttpResponse<TtransferContinuationResponse> = await this.checkTransactionAndRespondToMojaloop({
    //         transactionEnquiry,
    //         transferId,
    //         mtnRes,
    //         transferAccept
    //     });

    //     return sdkRes.data;
    // }
    
}


