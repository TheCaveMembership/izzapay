from db import conn

PRICES = [
    # Weapons
    ("wz_basic_pistol", 0),
    ("wz_cityrunner_smg", 100),
    ("wz_neon_marksman", 150),
    ("wz_skyline_sniper", 150),
    ("wz_pulse_rifle", 200),

    # Skins
    ("wz_basic_soldier", 0),
    ("wz_neon_edge", 50),
    ("wz_urban_shadow", 150),
    ("wz_cinder_camo", 200),
    ("wz_glow_legend", 500),
]

def main():
    with conn() as cx:
        for sku, price in PRICES:
            cx.execute(
                """
                UPDATE warzone_shop_items
                   SET price_izza = ?
                 WHERE sku = ?
                """,
                (price, sku),
            )

        cx.commit()

    print("✔ Warzone shop prices updated successfully")

if __name__ == "__main__":
    main()
