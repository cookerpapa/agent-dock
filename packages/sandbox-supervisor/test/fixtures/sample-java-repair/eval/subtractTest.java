public final class subtractTest {
    public static void main(String[] args) {
        if (Calculator.subtract(7, 3) != 4) throw new AssertionError("subtract");
        System.out.println("subtract passed");
    }
}
