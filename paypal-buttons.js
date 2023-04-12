window.XPayPalGateway = {
    error: {
        generic: 'We cannot process your PayPal payment now, please try again with another method.'
    }
}

function renderButtons() {
    let orderData = {}
    let wooCheckoutFormInfo = {}
    let wooOrder = null;

    paypal.Buttons({
        onInit: function (data, actions) { },
        onClick: function (data, actions) {
            return sendMessageToParentWindow('gr-onPaypalButtonClick', { data })
                .then(result => {
                    wooCheckoutFormInfo = result
                    return result
                })
                .catch(e => {
                    return actions.reject()
                })
        },
        createOrder: function (data, actions) {
            // console.log('createOrder', data, wooCheckoutFormInfo)
            let { shipping, purchase_units, intent = 'capture', billing } = wooCheckoutFormInfo || {}
            purchase_units = purchase_units.map(unit => ({
                ...unit,
                shipping: !shipping.country ? undefined : {
                    address: {
                        country_code: shipping.country,
                        address_line_1: shipping.address_1,
                        address_line_2: shipping.address_2,
                        postal_code: shipping.postcode,
                        admin_area_1: shipping.state || "",
                        admin_area_2: shipping.city || ""
                    },
                    name: {
                        full_name: `${shipping.first_name || ''} ${shipping.last_name || ''}`.trim()
                    }
                }
            }))
            const application_context = {
                brand_name: "merchant",
                user_action: "CONTINUE",
                shipping_preference: "NO_SHIPPING", // "SET_PROVIDED_ADDRESS",
            }
            const payer = !billing.email || !billing.country ? undefined : {
                email_address: billing.email,
                phone: !billing.phone ? undefined : {
                    phone_type: "MOBILE",
                    phone_number: {
                        national_number: billing.phone ? billing.phone.replace(/[^0-9]+/g, '') : ""
                    }, 
                },
                address: {
                    country_code: billing.country,
                    address_line_1: billing.address_1,
                    address_line_2: billing.address_2,
                    postal_code: billing.postcode,
                    admin_area_1: billing.state || "",
                    admin_area_2: billing.city || "",
                },
                name : {
                    given_name: billing.first_name,
                    surname: billing.last_name
                },
            }

            orderData = {
                intent,
                payer,
                purchase_units,
                application_context
            };

            return actions.order.create(orderData)
                .then(orderID => sendMessageToParentWindow('gr-onPaypalOrderCreated', { data: { orderID } }))
                .then((result) => {
                    wooOrder = result
                    return result.orderID
                })
        },
        onApprove: function (data, actions) {
            //console.log('onApprove', data)
            const orderId = wooOrder.order_id;
            if(orderId) {
                return actions.order.capture()
                    .then(function (details) {
                        return postMessageToParentWindow('gr-onPaypalOrderCompleted', { data: { ...details, order_id: orderId } })
                    })
                    .catch(e => {
                        return postMessageToParentWindow('gr-onPaypalOrderCancel', { data: { ...details, order_id: orderId } })
                    });
            } else {
                postMessageToParentWindow('gr-onPaypalOrderError', { error: XPayPalGateway.error.generic });
            }
        },
        onCancel: function (data) {
            postMessageToParentWindow('gr-onPaypalOrderCancel', { data });
        },
        onError: function (error) {
            //console.error('On Paypal Error', error)
            let errMsg = null
            if (error.message) {
                let jsonErrorText = error.message.match(/{(.*)}$/gm)
                let jsonError = JSON.parse(jsonErrorText)
                if (jsonError && jsonError.name && jsonError.message) {
                    errMsg = `[${jsonError.name}] ${jsonError.message}`
                }
            }

            if(errMsg && !errMsg.includes('popup close')) {
                postMessageToParentWindow('gr-onPaypalOrderError', { error: errMsg || XPayPalGateway.error.generic });
            }
        }
    }).render('#paypal-button-container');
}

function registerObserver() {
    jQuery(document).ready(() => {
        new MutationObserver(function (mutations) {
            mutations.find(mutation => {
                if (mutation.addedNodes.length) {
                    let node = [...mutation.addedNodes].find(node => node.id.startsWith("paypal-overlay-uid"))
                    node && handleOverlayShow(node)
                }

                if (mutation.removedNodes.length) {
                    let node = [...mutation.removedNodes].find(node => node.id.startsWith("paypal-overlay-uid"))
                    node && handleOverlayHide(node)
                }
            })
        }).observe(document, { attributes: true, childList: true, characterData: false, subtree: true });

        const resizeElement = document.getElementById('paypal-button-container');
        new ResizeObserver((entries) => {
            for (const entry of entries) {
                postMessageToParentWindow('gr-onPaypalResize', { data: { height: entry.target.clientHeight } })
            }
        }).observe(resizeElement);
    })
}

if (!window.ResizeObserver) {
    loadjs("https://unpkg.com/browse/resize-observer-polyfill@1.0.0/dist/ResizeObserver.js", function () {
        registerObserver()
    });
} else {
    registerObserver()
}

function handleOverlayShow(node) {
    let iframe = document.querySelector('iframe[name*="_paypal-overlay-uid_"]')
    if (iframe && iframe.contentDocument) {
        jQuery(iframe).css('border', 'none')
        jQuery('#paypal-button-container').css('display', 'none')
        postMessageToParentWindow("gr-onPaypalShowOverlay")
    }
}

function handleOverlayHide(node) {
    jQuery('#paypal-button-container').css('display', '')
    postMessageToParentWindow("gr-onPaypalHideOverlay")
}

function postMessageToParentWindow(key, { data, error } = {}) {
    let postData = { type: 'gr-event', key, data, error }
    window.parent.postMessage(postData, "*");
}

function sendMessageToParentWindow(key, { data, error } = {}) {
    return new Promise((res, rej) => {
        let timeoutSchedule
        const channel = new MessageChannel();
        channel.port1.onmessage = ({ data }) => {
            channel.port1.close();
            timeoutSchedule && clearTimeout(timeoutSchedule)

            if (data.error || !data.data) {
                rej(data.error || 'Unknown error');
            } else {
                res(data.data);
            }
        };
        channel.port1.onmessageerror = (e) => {
            channel.port1.close();
            timeoutSchedule && clearTimeout(timeoutSchedule)
        }

        timeoutSchedule = setTimeout(() => {
            channel.port1.close();
            rej('Timeout');
        }, 10000)

        window.parent.postMessage({ type: 'gr-event', key, data, error }, "*", [channel.port2]);
    });
}

let paramsJson = '{"' + decodeURI(window.location.search.slice(1).replace(/&/g, "\",\"").replace(/=/g, "\":\"")) + '"}'
let urlParams = paramsJson == '{""}' ? {} : JSON.parse(paramsJson)
let paypalParams = {
    "vault": urlParams['vault'] || 'true',
    "commit": urlParams['commit'] || 'false',
    "components": urlParams['components'],
    "intent": urlParams['intent'] || 'capture',
    "client-id": urlParams['client-id'],
    "enable-funding": urlParams['enable-funding'],
}

document.addEventListener("DOMContentLoaded", () => {
  window.paypalLoadScript(paypalParams).then((paypal) => {
    renderButtons()
    postMessageToParentWindow('gr-onPaypalResize', { data: { height: jQuery('#paypal-button-container').height() } })
  });
});
