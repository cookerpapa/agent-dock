public final class maximumTest {
    public static void main(String[] args) {
        if (Calculator.maximum(-2, 4) != 4) throw new AssertionError("maximum");
        System.out.println("maximum passed");
    }
}
