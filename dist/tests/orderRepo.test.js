"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const orderCreate_mapper_1 = require("../src/services/orders/orderCreate.mapper");
describe("mapCreateOrderDtoToRepoPayload", () => {
    it("maps a basic order payload without address-book lookups", async () => {
        const payload = await (0, orderCreate_mapper_1.mapCreateOrderDtoToRepoPayload)({
            customerEntityId: null,
            sender: { name: "Alice", phone: "+49111" },
            receiver: { name: "Bob", phone: "+49222" },
            addresses: {
                senderAddressId: null,
                receiverAddressId: null,
                pickupAddress: "Hamburg Warehouse Street 1",
                dropoffAddress: "Berlin Delivery Street 2",
                destinationCity: "Berlin",
                savePickupToAddressBook: false,
                saveDropoffToAddressBook: false,
            },
            shipment: {
                serviceType: "DOOR_TO_DOOR",
                weightKg: 2.5,
                codEnabled: false,
                codAmount: 50,
                currency: "EUR",
            },
            payment: null,
            schedule: null,
            reference: null,
            amount: 19.99,
        });
        expect(payload.pickupAddress).toBe("Hamburg Warehouse Street 1");
        expect(payload.dropoffAddress).toBe("Berlin Delivery Street 2");
        expect(payload.destinationCity).toBe("Berlin");
        expect(payload.senderName).toBe("Alice");
        expect(payload.receiverName).toBe("Bob");
        expect(payload.codAmount).toBeNull();
        expect(payload.currency).toBeNull();
        expect(payload.amount).toBe(19.99);
    });
});
