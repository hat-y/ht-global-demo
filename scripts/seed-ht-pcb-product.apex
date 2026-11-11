// Idempotent: activates the Standard Price Book and ensures the active product
// "PCB Fabrication" (HT-PCB-FAB) has a Standard Price Book entry at 0.
// Run: sf apex run -o ht-global -f scripts/seed-ht-pcb-product.apex
Pricebook2 standard = [SELECT Id, IsActive FROM Pricebook2 WHERE IsStandard = true LIMIT 1];
if (!standard.IsActive) {
    standard.IsActive = true;
    update standard;
    System.debug('RESULT standard price book activated');
}
List<Product2> products = [SELECT Id, IsActive, Name FROM Product2 WHERE ProductCode = 'HT-PCB-FAB' LIMIT 1];
Product2 product;
if (products.isEmpty()) {
    product = new Product2(Name = 'PCB Fabrication', ProductCode = 'HT-PCB-FAB', IsActive = true,
        Description = 'Custom PCB fabrication (HT Global Circuits instant quote)');
    insert product;
    System.debug('RESULT product created ' + product.Id);
} else {
    product = products[0];
    if (!product.IsActive) {
        product.IsActive = true;
        update product;
        System.debug('RESULT product reactivated');
    }
}
List<PricebookEntry> entries = [
    SELECT Id, IsActive FROM PricebookEntry WHERE Pricebook2Id = :standard.Id AND Product2Id = :product.Id LIMIT 1
];
if (entries.isEmpty()) {
    insert new PricebookEntry(Pricebook2Id = standard.Id, Product2Id = product.Id, UnitPrice = 0, IsActive = true);
    System.debug('RESULT standard pricebook entry created');
} else if (!entries[0].IsActive) {
    entries[0].IsActive = true;
    update entries[0];
    System.debug('RESULT pricebook entry reactivated');
}
System.debug('RESULT done product=' + product.Id + ' standardPricebook=' + standard.Id);
